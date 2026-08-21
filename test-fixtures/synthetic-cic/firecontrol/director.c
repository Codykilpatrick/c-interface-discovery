/*
 * director.c — Publishes MSG_TYPE_ENGAGE.
 *
 * Payload is a cast of a raw buffer (payload strategy: cast).
 *
 * Cross-app: [fire control / director] --MSG_TYPE_ENGAGE--> [CIC / link_gateway]
 */

#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "fc_types.h"

extern int g_fc_running;

static cic_bus_t g_bus  = NULL;
static int       g_sock = -1;
static unsigned int g_seq = 0;

static void send_engage(TrackKinematics *aim, unsigned int track_id)
{
    unsigned char buf[sizeof(EngageMsg)];
    EngageMsg *msg = (EngageMsg *)buf;

    memset(buf, 0, sizeof(buf));
    msg->hdr.msg_type = MSG_TYPE_ENGAGE;
    msg->hdr.length   = sizeof(EngageMsg);
    msg->hdr.seq      = g_seq++;
    msg->track_id     = track_id;
    msg->weapon_id    = 1;
    msg->auth_flags   = 0x03;
    msg->aim          = *aim;

    cic_bus_send(g_bus, MSG_TYPE_ENGAGE, sizeof(EngageMsg), (EngageMsg *)buf);
    send(g_sock, buf, sizeof(EngageMsg), 0);
}

int director_main(void)
{
    struct sockaddr_in addr;
    TrackKinematics aim;

    g_bus = cic_bus_connect(CIC_BUS_ENDPOINT);
    if (!g_bus) return -1;

    g_sock = socket(AF_INET, SOCK_STREAM, 0);
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(CIC_ENGAGE_PORT);
    inet_aton("127.0.0.1", &addr.sin_addr);
    if (connect(g_sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) return -1;

    while (g_fc_running) {
        memset(&aim, 0, sizeof(aim));
        aim.motion.pos.horiz.lat = 32.1f;
        aim.motion.pos.horiz.lon = -117.2f;
        aim.snr = 0.9f;
        send_engage(&aim, 100);
        usleep(500000);
    }

    cic_bus_close(g_bus);
    close(g_sock);
    return 0;
}
