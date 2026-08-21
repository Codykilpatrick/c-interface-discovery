/*
 * beamformer.c — Turns hydrophone frames into MSG_TYPE_TRACK.
 *
 * Fills a byte buffer with memcpy from a typed TrackMsg, then publishes
 * on the CIC bus (payload strategy: memcpy) and on a TCP socket (so the
 * cross-app graph works even without cid-config.json).
 *
 * Cross-app: [sonar / beamformer] --MSG_TYPE_TRACK--> [CIC / track_router]
 */

#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/shm.h>
#include <sys/ipc.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "sonar_types.h"
#include "cic_bus.h"

extern int g_sonar_running;

static cic_bus_t    g_bus     = NULL;
static int          g_sock    = -1;
static int          g_shm_id  = -1;
static SonarFrame  *g_frame   = NULL;
static unsigned int g_seq     = 0;
static unsigned int g_track_id = 100;

static int connect_cic_socket(void)
{
    struct sockaddr_in addr;

    g_sock = socket(AF_INET, SOCK_STREAM, 0);
    if (g_sock < 0) return -1;

    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(CIC_TRACK_PORT);
    inet_aton(CIC_BUS_ENDPOINT, &addr.sin_addr);
    return connect(g_sock, (struct sockaddr *)&addr, sizeof(addr));
}

static void publish_track(const TrackMsg *track)
{
    unsigned char outbuf[sizeof(TrackMsg)];

    memcpy(outbuf, track, sizeof(TrackMsg));
    cic_bus_send(g_bus, MSG_TYPE_TRACK, sizeof(TrackMsg), outbuf);
    send(g_sock, outbuf, sizeof(TrackMsg), 0);
}

static void *beam_thread(void *arg)
{
    TrackMsg track;
    (void)arg;

    while (g_sonar_running) {
        if (g_frame == NULL || g_frame->n_beams == 0) {
            usleep(50000);
            continue;
        }

        memset(&track, 0, sizeof(track));
        track.hdr.msg_type = MSG_TYPE_TRACK;
        track.hdr.length   = sizeof(TrackMsg);
        track.hdr.seq      = g_seq++;
        track.track_id     = g_track_id;
        track.kin.motion.pos.horiz.when.wall.tv_sec = 1;
        track.kin.motion.pos.horiz.lat              = 32.1f;
        track.kin.motion.pos.horiz.lon              = -117.2f;
        track.kin.motion.pos.depth                  = 80.0f;
        track.kin.snr                               = g_frame->beams[0].peak / 20.0f;
        track.source       = 0;

        publish_track(&track);
        usleep(100000);
    }
    return NULL;
}

int beamformer_main(void)
{
    pthread_t tid;

    g_bus = cic_bus_connect(CIC_BUS_ENDPOINT);
    if (!g_bus) return -1;
    if (connect_cic_socket() != 0) return -1;

    g_shm_id = shmget(SONAR_SHM_KEY, SONAR_SHM_SIZE, 0666);
    if (g_shm_id < 0) return -1;
    g_frame = (SonarFrame *)shmat(g_shm_id, NULL, SHM_RDONLY);
    if (g_frame == (void *)-1) return -1;

    pthread_create(&tid, NULL, beam_thread, NULL);
    pthread_join(tid, NULL);

    shmdt(g_frame);
    cic_bus_close(g_bus);
    close(g_sock);
    return 0;
}
