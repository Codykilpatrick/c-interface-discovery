/*
 * picture.c — Tactical picture.
 *
 * Consumes MSG_TYPE_CONTACT from sonar and MSG_TYPE_OWN_SHIP from nav.
 * Emits MSG_TYPE_HEARTBEAT on the bus. Writes the picture table to
 * shared memory for track_router.
 */

#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/shm.h>
#include <sys/ipc.h>
#include <sys/sem.h>
#include <netinet/in.h>
#include "cic_types.h"

extern int g_cic_running;

static int            g_listen  = -1;
static int            g_shm_id  = -1;
static int            g_sem_id  = -1;
static PictureTable  *g_picture = NULL;
static cic_bus_t      g_bus     = NULL;
static unsigned int   g_seq     = 0;

static int init_listener(void)
{
    struct sockaddr_in addr;
    int opt = 1;

    g_listen = socket(AF_INET, SOCK_STREAM, 0);
    if (g_listen < 0) return -1;
    setsockopt(g_listen, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port        = htons(CIC_PICTURE_PORT);
    if (bind(g_listen, (struct sockaddr *)&addr, sizeof(addr)) < 0) return -1;
    return listen(g_listen, 8);
}

static int init_picture_shm(void)
{
    g_shm_id = shmget(CIC_SHM_KEY, CIC_SHM_SIZE, IPC_CREAT | 0666);
    if (g_shm_id < 0) return -1;
    g_picture = (PictureTable *)shmat(g_shm_id, NULL, 0);
    if (g_picture == (void *)-1) return -1;
    memset(g_picture, 0, sizeof(*g_picture));

    g_sem_id = semget(CIC_SEM_KEY, 1, IPC_CREAT | 0666);
    return (g_sem_id < 0) ? -1 : 0;
}

static void send_heartbeat(void)
{
    HeartbeatMsg hb;

    memset(&hb, 0, sizeof(hb));
    hb.hdr.msg_type = MSG_TYPE_HEARTBEAT;
    hb.hdr.length   = sizeof(HeartbeatMsg);
    hb.hdr.seq      = g_seq++;
    hb.origin       = 1;
    cic_bus_send(g_bus, MSG_TYPE_HEARTBEAT, sizeof(HeartbeatMsg), &hb);
}

static void ingest(const unsigned char *buf, unsigned int len)
{
    const CicHeader *hdr;

    if (len < sizeof(CicHeader)) return;
    hdr = (const CicHeader *)buf;

    if (hdr->msg_type == MSG_TYPE_CONTACT && len >= sizeof(ContactMsg)) {
        const ContactMsg *c = (const ContactMsg *)buf;
        if (g_picture->count < CIC_MAX_TRACKS) {
            TrackMsg *t = &g_picture->tracks[g_picture->count++];
            memset(t, 0, sizeof(*t));
            t->hdr.msg_type = MSG_TYPE_TRACK;
            t->track_id     = 200 + c->body.sensor_id;
            t->kin          = c->body.kin;
            t->source       = 0;
        }
    } else if (hdr->msg_type == MSG_TYPE_OWN_SHIP && len >= sizeof(OwnShipMsg)) {
        /* Own-ship updates the origin only — not forwarded as a track. */
        (void)buf;
    }
}

int picture_main(void)
{
    unsigned char buf[CIC_MAX_PAYLOAD];
    int fd, n;

    g_bus = cic_bus_connect(CIC_BUS_ENDPOINT);
    if (!g_bus) return -1;
    if (init_listener() != 0) return -1;
    if (init_picture_shm() != 0) return -1;

    while (g_cic_running) {
        fd = accept(g_listen, NULL, NULL);
        if (fd < 0) continue;
        while (g_cic_running) {
            n = recv(fd, buf, sizeof(buf), 0);
            if (n <= 0) break;
            ingest(buf, (unsigned int)n);
            send_heartbeat();
        }
        close(fd);
    }

    shmdt(g_picture);
    cic_bus_close(g_bus);
    close(g_listen);
    return 0;
}
