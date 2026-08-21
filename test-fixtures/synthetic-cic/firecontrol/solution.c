/*
 * solution.c — Consumes MSG_TYPE_TRACK via callback registration.
 *
 * cic_bus_register(..., on_track, ...) is Strategy 5 (callback). Import
 * cid-config.json so callbackArgIndex is set.
 *
 * Cross-app: [CIC / track_router] --MSG_TYPE_TRACK--> [fire control / solution]
 */

#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include "fc_types.h"

extern int g_fc_running;

static cic_bus_t   g_bus    = NULL;
static int         g_listen = -1;
static TrackMsg    g_last;

static void on_track(cic_bus_t bus, unsigned int msg_id,
                     unsigned int len, void *data, cic_passback_t pb)
{
    TrackMsg *track = (TrackMsg *)data;
    (void)bus; (void)pb;
    if (msg_id != MSG_TYPE_TRACK) return;
    if (len < sizeof(TrackMsg)) return;
    g_last = *track;
}

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
    addr.sin_port        = htons(FC_ENGAGE_PORT);
    if (bind(g_listen, (struct sockaddr *)&addr, sizeof(addr)) < 0) return -1;
    return listen(g_listen, 4);
}

int solution_main(void)
{
    unsigned char buf[CIC_MAX_PAYLOAD];
    int fd, n;

    g_bus = cic_bus_connect(CIC_BUS_ENDPOINT);
    if (!g_bus) return -1;
    cic_bus_register(g_bus, MSG_TYPE_TRACK, on_track, NULL);
    if (init_listener() != 0) return -1;

    while (g_fc_running) {
        fd = accept(g_listen, NULL, NULL);
        if (fd < 0) continue;
        n = recv(fd, buf, sizeof(buf), 0);
        if (n >= (int)sizeof(TrackMsg)) {
            const TrackMsg *t = (const TrackMsg *)buf;
            if (t->hdr.msg_type == MSG_TYPE_TRACK)
                g_last = *t;
        }
        close(fd);
    }

    cic_bus_close(g_bus);
    close(g_listen);
    return 0;
}
