/*
 * track_router.c — Transit for MSG_TYPE_TRACK.
 *
 * Receives tracks from sonar (and from the local picture table) and
 * forwards them to fire control. CIC both produces and consumes
 * MSG_TYPE_TRACK, so the app graph should route sonar → CIC → fire control
 * rather than drawing a false direct edge.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/msg.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "cic_types.h"

extern int g_cic_running;

static int         g_listen  = -1;
static int         g_fc_sock = -1;
static int         g_mq      = -1;
static int         g_shm_id  = -1;
static PictureTable *g_picture = NULL;
static cic_bus_t   g_bus     = NULL;

typedef struct {
    long            mtype;
    unsigned char   payload[CIC_MAX_PAYLOAD];
    unsigned int    len;
} TrackRouteMsg;

static int init_track_listener(void)
{
    struct sockaddr_in addr;
    int opt = 1;

    g_listen = socket(AF_INET, SOCK_STREAM, 0);
    if (g_listen < 0) return -1;
    setsockopt(g_listen, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port        = htons(CIC_TRACK_PORT);
    if (bind(g_listen, (struct sockaddr *)&addr, sizeof(addr)) < 0) return -1;
    return listen(g_listen, 8);
}

static int init_fc_socket(void)
{
    struct sockaddr_in addr;

    g_fc_sock = socket(AF_INET, SOCK_STREAM, 0);
    if (g_fc_sock < 0) return -1;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(FC_ENGAGE_PORT);
    inet_aton("127.0.0.1", &addr.sin_addr);
    return connect(g_fc_sock, (struct sockaddr *)&addr, sizeof(addr));
}

static void forward_track(const TrackMsg *track)
{
    TrackRouteMsg qmsg;

    qmsg.mtype = MSG_TYPE_TRACK;
    qmsg.len   = sizeof(TrackMsg);
    memcpy(qmsg.payload, track, sizeof(TrackMsg));
    msgsnd(g_mq, &qmsg, sizeof(qmsg) - sizeof(long), 0);

    cic_bus_send(g_bus, MSG_TYPE_TRACK, sizeof(TrackMsg), track);
    send(g_fc_sock, track, sizeof(TrackMsg), 0);
}

static void handle_client(int fd)
{
    unsigned char buf[CIC_MAX_PAYLOAD];
    int n;

    while (g_cic_running) {
        n = recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) break;
        if ((unsigned int)n < sizeof(CicHeader)) continue;

        const CicHeader *hdr = (const CicHeader *)buf;
        if (hdr->msg_type != MSG_TYPE_TRACK) continue;
        if ((unsigned int)n < sizeof(TrackMsg)) continue;

        forward_track((const TrackMsg *)buf);
    }
    close(fd);
}

int track_router_main(void)
{
    unsigned int msg_id = 0, size = 0;
    TrackMsg     bus_track;

    g_bus = cic_bus_connect(CIC_BUS_ENDPOINT);
    if (!g_bus) return -1;
    if (init_track_listener() != 0) return -1;
    if (init_fc_socket() != 0) return -1;

    g_mq = msgget(CIC_MQ_KEY, IPC_CREAT | 0666);
    if (g_mq < 0) return -1;

    g_shm_id = shmget(CIC_SHM_KEY, CIC_SHM_SIZE, 0666);
    if (g_shm_id >= 0)
        g_picture = (PictureTable *)shmat(g_shm_id, NULL, SHM_RDONLY);

    while (g_cic_running) {
        int fd = accept(g_listen, NULL, NULL);
        if (fd >= 0) handle_client(fd);

        if (cic_bus_recv(g_bus, &msg_id, &size, &bus_track) == 0 &&
            msg_id == MSG_TYPE_TRACK) {
            forward_track(&bus_track);
        }
    }

    if (g_picture) shmdt(g_picture);
    cic_bus_close(g_bus);
    close(g_listen);
    close(g_fc_sock);
    return 0;
}
