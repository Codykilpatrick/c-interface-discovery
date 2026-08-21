/*
 * ownship_publisher.c — Publishes MSG_TYPE_OWN_SHIP.
 *
 * Payload is stashed in a void* then sent (payload strategy: prior assignment).
 * Also reads the INS via file I/O.
 *
 * Cross-app: [nav / ownship_publisher] --MSG_TYPE_OWN_SHIP--> [CIC / picture]
 */

#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "nav_types.h"
#include "cic_bus.h"

extern int g_nav_running;

static cic_bus_t g_bus  = NULL;
static int       g_sock = -1;
static int       g_ins  = -1;

static void publish_ownship(float lat, float lon, float heading)
{
    OwnShipMsg msg;
    unsigned int   msg_id;
    unsigned int   msg_size;
    void          *msg_data;

    memset(&msg, 0, sizeof(msg));
    msg.hdr.msg_type = MSG_TYPE_OWN_SHIP;
    msg.hdr.length   = sizeof(OwnShipMsg);
    msg.motion.pos.horiz.lat = lat;
    msg.motion.pos.horiz.lon = lon;
    msg.motion.pos.depth     = 0.0f;
    msg.motion.heading       = heading;
    msg.motion.speed_kt      = 12.0f;
    msg.fix_quality          = 2;

    msg_id   = MSG_TYPE_OWN_SHIP;
    msg_size = sizeof(OwnShipMsg);
    msg_data = &msg;

    cic_bus_send(g_bus, msg_id, msg_size, msg_data);
    send(g_sock, &msg, sizeof(OwnShipMsg), 0);
}

int ownship_publisher_main(void)
{
    struct sockaddr_in addr;
    unsigned char ins_buf[32];
    int n;

    g_bus = cic_bus_connect(CIC_BUS_ENDPOINT);
    if (!g_bus) return -1;

    g_sock = socket(AF_INET, SOCK_STREAM, 0);
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(CIC_PICTURE_PORT);
    inet_aton(CIC_BUS_ENDPOINT, &addr.sin_addr);
    if (connect(g_sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) return -1;

    g_ins = open(INS_DEV, O_RDONLY);

    while (g_nav_running) {
        n = read(g_ins, ins_buf, sizeof(ins_buf));
        (void)n;
        publish_ownship(32.12f, -117.21f, 270.0f);
        usleep(250000);
    }

    cic_bus_close(g_bus);
    close(g_sock);
    close(g_ins);
    return 0;
}
