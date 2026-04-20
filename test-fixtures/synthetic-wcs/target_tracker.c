/*
 * target_tracker.c — Maintains the active track table for the WCS.
 *
 * Consumes MSG_TYPE_TARGET_LOCK messages from the internal WCS message queue
 * (published by solution_receiver).  Merges incoming locks into the track
 * table, ages out stale entries, and writes the authoritative track table to
 * WCS shared memory so weapons_director can read it without queuing.
 *
 * Internal data flows:
 *   [solution_receiver] --MSG_TYPE_TARGET_LOCK--> [target_tracker]   (via mqueue)
 *   [target_tracker]    --track table-----------> [weapons_director] (via shared mem)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/msg.h>
#include <sys/shm.h>
#include <sys/ipc.h>
#include "wcs_types.h"

#define WCS_SHM_KEY      0x5754   /* 'WT' — track table shared memory */
#define WCS_SHM_SIZE     4096
#define MAX_TRACKS       16

extern int g_wcs_running;

typedef struct {
    unsigned int  track_id;
    unsigned int  bearing;
    unsigned int  range;
    float         confidence;
    unsigned int  flags;
    time_t        last_update;
} TrackEntry;

typedef struct {
    unsigned int  count;
    TrackEntry    tracks[MAX_TRACKS];
} TrackTable;

static int         g_mq_id   = -1;
static int         g_shm_id  = -1;
static TrackTable *g_tracks  = NULL;

typedef struct {
    long          mtype;
    TargetLockMsg payload;
} MqTargetLock;

static int init_queue_reader(void)
{
    g_mq_id = msgget(WCS_MQ_KEY, 0666);
    return (g_mq_id < 0) ? -1 : 0;
}

static int init_track_shm(void)
{
    g_shm_id = shmget(WCS_SHM_KEY, WCS_SHM_SIZE, IPC_CREAT | 0666);
    if (g_shm_id < 0) return -1;
    g_tracks = (TrackTable *)shmat(g_shm_id, NULL, 0);
    if (g_tracks == (void *)-1) return -1;
    memset(g_tracks, 0, sizeof(TrackTable));
    return 0;
}

static TrackEntry *find_or_alloc_track(unsigned int track_id)
{
    unsigned int i;

    for (i = 0; i < g_tracks->count; i++) {
        if (g_tracks->tracks[i].track_id == track_id)
            return &g_tracks->tracks[i];
    }

    if (g_tracks->count < MAX_TRACKS) {
        TrackEntry *t = &g_tracks->tracks[g_tracks->count++];
        memset(t, 0, sizeof(TrackEntry));
        t->track_id = track_id;
        return t;
    }

    /* Evict oldest stale entry */
    TrackEntry *oldest = &g_tracks->tracks[0];
    for (i = 1; i < g_tracks->count; i++) {
        if (g_tracks->tracks[i].last_update < oldest->last_update)
            oldest = &g_tracks->tracks[i];
    }
    memset(oldest, 0, sizeof(TrackEntry));
    oldest->track_id = track_id;
    return oldest;
}

static void update_track(const TargetLockMsg *lock)
{
    TrackEntry *t = find_or_alloc_track(lock->track_id);

    t->bearing     = lock->bearing;
    t->range       = lock->range;
    t->confidence  = lock->confidence;
    t->flags       = lock->lock_flags;
    t->last_update = time(NULL);

    fprintf(stderr, "target_tracker: track %u bearing=%u range=%u conf=%.2f\n",
            t->track_id, t->bearing, t->range, t->confidence);
}

static void age_tracks(void)
{
    time_t now = time(NULL);
    unsigned int i;

    for (i = 0; i < g_tracks->count; i++) {
        TrackEntry *t = &g_tracks->tracks[i];
        if ((now - t->last_update) > LOCK_STALE_SEC) {
            t->flags |= 0x02;   /* LOCK_STALE */
        }
    }
}

int target_tracker_main(void)
{
    MqTargetLock mqmsg;

    if (init_queue_reader() != 0) {
        perror("target_tracker: msgget");
        return -1;
    }

    if (init_track_shm() != 0) {
        perror("target_tracker: shmget");
        return -1;
    }

    while (g_wcs_running) {
        if (msgrcv(g_mq_id, &mqmsg, sizeof(TargetLockMsg),
                   MSG_TYPE_TARGET_LOCK, MSG_NOERROR) < 0) {
            continue;
        }

        update_track(&mqmsg.payload);
        age_tracks();
    }

    shmdt(g_tracks);
    return 0;
}
