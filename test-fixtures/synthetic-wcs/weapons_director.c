/*
 * weapons_director.c — Authorises and executes weapon releases.
 *
 * Reads the active track table from WCS shared memory (written by
 * target_tracker) and the authorization token from the console pipe
 * (written by wcs_console).  When a valid launch authorization arrives for
 * a locked track, weapons_director sends a MSG_TYPE_COMMAND back to the
 * acoustic sensor array to adjust sensor gain and rate for the engagement,
 * then sends a MSG_TYPE_WEAPON_STATUS to the weapons management subsystem.
 *
 * Cross-application data flow:
 *   [WCS / weapons_director] --MSG_TYPE_COMMAND--> [sensor array / command_receiver]
 *
 * Internal data flows:
 *   [target_tracker]  --track table (shm)----> [weapons_director]
 *   [wcs_console]     --MSG_TYPE_LAUNCH_AUTH-> [weapons_director]  (via named pipe)
 *   [weapons_director]--MSG_TYPE_WEAPON_STATUS-> [wcs_console]     (via named pipe)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/shm.h>
#include <sys/ipc.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "wcs_types.h"

#define WCS_SHM_KEY      0x5754
#define WCS_SHM_SIZE     4096
#define MAX_TRACKS       16

#define CMD_SET_GAIN     0x01   /* sensor array command IDs — must match sensor_defs.h */
#define CMD_SET_RATE     0x02

extern int g_wcs_running;

typedef struct {
    unsigned int  track_id;
    unsigned int  bearing;
    unsigned int  range;
    float         confidence;
    unsigned int  flags;
    long          last_update;
} TrackEntry;

typedef struct {
    unsigned int  count;
    TrackEntry    tracks[MAX_TRACKS];
} TrackTable;

static int          g_cmd_fd   = -1;   /* TCP socket to sensor array command_receiver */
static int          g_pipe_fd  = -1;   /* named pipe from wcs_console */
static int          g_shm_id   = -1;
static TrackTable  *g_tracks   = NULL;
static unsigned int g_seq      = 0;

static int init_sensor_cmd_socket(void)
{
    struct sockaddr_in addr;

    g_cmd_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (g_cmd_fd < 0) return -1;

    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(SENSOR_CMD_PORT);
    inet_aton(SENSOR_CMD_ADDR, &addr.sin_addr);

    return connect(g_cmd_fd, (struct sockaddr *)&addr, sizeof(addr));
}

static int init_auth_pipe(void)
{
    g_pipe_fd = open(WCS_PIPE_AUTH, O_RDONLY | O_NONBLOCK);
    return (g_pipe_fd < 0) ? -1 : 0;
}

static int init_track_shm(void)
{
    g_shm_id = shmget(WCS_SHM_KEY, WCS_SHM_SIZE, 0666);
    if (g_shm_id < 0) return -1;
    g_tracks = (TrackTable *)shmat(g_shm_id, NULL, SHM_RDONLY);
    return (g_tracks == (void *)-1) ? -1 : 0;
}

static const TrackEntry *find_confirmed_track(unsigned int track_id)
{
    unsigned int i;
    for (i = 0; i < g_tracks->count; i++) {
        if (g_tracks->tracks[i].track_id == track_id &&
            (g_tracks->tracks[i].flags & 0x01) &&        /* LOCK_CONFIRMED */
            !(g_tracks->tracks[i].flags & 0x02))          /* not LOCK_STALE */
            return &g_tracks->tracks[i];
    }
    return NULL;
}

/*
 * Send a command to the acoustic sensor array to optimise parameters for
 * the engagement: full gain and maximum sample rate.
 */
static void send_engagement_command(void)
{
    CommandMsg cmd;

    cmd.header.msg_type    = MSG_TYPE_COMMAND;
    cmd.header.seq_num     = g_seq++;
    cmd.header.payload_len = sizeof(CommandMsg);
    cmd.header.checksum    = 0;

    cmd.command_id = CMD_SET_GAIN;
    cmd.param1     = 100;   /* 100 = 1.00 gain (100% of max) */
    cmd.param2     = 0;

    send(g_cmd_fd, &cmd, sizeof(CommandMsg), 0);

    cmd.command_id = CMD_SET_RATE;
    cmd.param1     = 100;   /* maximum sample rate */
    cmd.param2     = 0;
    cmd.header.seq_num = g_seq++;

    send(g_cmd_fd, &cmd, sizeof(CommandMsg), 0);
}

static void process_launch_auth(const LaunchAuthMsg *auth)
{
    const TrackEntry *track;

    /* Require both captain and XO authorization */
    if ((auth->auth_flags & 0x03) != 0x03) {
        fprintf(stderr, "weapons_director: auth incomplete (flags=0x%02x)\n",
                auth->auth_flags);
        return;
    }

    track = find_confirmed_track(auth->track_id);
    if (!track) {
        fprintf(stderr, "weapons_director: no confirmed track %u\n",
                auth->track_id);
        return;
    }

    if (track->confidence < LOCK_CONFIDENCE_MIN) {
        fprintf(stderr, "weapons_director: track confidence %.2f below threshold\n",
                track->confidence);
        return;
    }

    fprintf(stderr, "weapons_director: launch authorized — track %u bearing=%u\n",
            track->track_id, track->bearing);

    /*
     * Adjust sensor array for engagement before weapon release.
     * MSG_TYPE_COMMAND sent to sensor array command_receiver.
     */
    send_engagement_command();
}

static void poll_auth_pipe(void)
{
    unsigned char buf[sizeof(LaunchAuthMsg)];
    int n;

    n = read(g_pipe_fd, buf, sizeof(buf));
    if (n < (int)sizeof(MsgHeader)) return;

    const MsgHeader *hdr = (const MsgHeader *)buf;
    if (hdr->msg_type != MSG_TYPE_LAUNCH_AUTH) return;
    if (n < (int)sizeof(LaunchAuthMsg)) return;

    process_launch_auth((const LaunchAuthMsg *)buf);
}

int weapons_director_main(void)
{
    if (init_sensor_cmd_socket() != 0) {
        perror("weapons_director: connect to sensor array");
        return -1;
    }

    if (init_auth_pipe() != 0) {
        perror("weapons_director: open auth pipe");
        return -1;
    }

    if (init_track_shm() != 0) {
        perror("weapons_director: track shm");
        return -1;
    }

    while (g_wcs_running) {
        poll_auth_pipe();
        usleep(50000);  /* 20 Hz poll */
    }

    shmdt(g_tracks);
    close(g_cmd_fd);
    close(g_pipe_fd);
    return 0;
}
