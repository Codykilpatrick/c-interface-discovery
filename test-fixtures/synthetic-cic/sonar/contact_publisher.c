/*
 * contact_publisher.c — Publishes MSG_TYPE_CONTACT.
 *
 * send_contact() takes a typed pointer (payload strategy: pointer).
 * Fills six nested app layers plus timeval / sockaddr_in from usr/include.
 *
 * Cross-app: [sonar / contact_publisher] --MSG_TYPE_CONTACT--> [CIC / picture]
 */

#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "sonar_types.h"
#include "cic_bus.h"

extern int g_sonar_running;

static cic_bus_t    g_bus  = NULL;
static int          g_sock = -1;
static unsigned int g_seq  = 0;

static void send_contact(ContactMsg *contact)
{
    contact->hdr.msg_type = MSG_TYPE_CONTACT;
    cic_bus_send(g_bus, MSG_TYPE_CONTACT, sizeof(ContactMsg), contact);
    send(g_sock, contact, sizeof(ContactMsg), 0);
}

static void send_enum_tagged(ContactMsg *contact)
{
    cic_bus_send(g_bus, (CicBusMsgId)CIC_BUS_CONTACT, sizeof(ContactMsg), contact);
}

int contact_publisher_main(void)
{
    struct sockaddr_in addr;
    ContactMsg msg;

    g_bus = cic_bus_connect(CIC_BUS_ENDPOINT);
    if (!g_bus) return -1;

    g_sock = socket(AF_INET, SOCK_STREAM, 0);
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(CIC_PICTURE_PORT);
    inet_aton(CIC_BUS_ENDPOINT, &addr.sin_addr);
    if (connect(g_sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) return -1;

    while (g_sonar_running) {
        memset(&msg, 0, sizeof(msg));
        msg.hdr.msg_type = MSG_TYPE_CONTACT;
        msg.hdr.length   = sizeof(ContactMsg);
        msg.hdr.seq      = g_seq++;

        msg.body.kin.motion.pos.horiz.when.wall.tv_sec  = 1;
        msg.body.kin.motion.pos.horiz.when.wall.tv_usec = 0;
        msg.body.kin.motion.pos.horiz.when.nsec         = 0;
        msg.body.kin.motion.pos.horiz.lat               = 32.15f;
        msg.body.kin.motion.pos.horiz.lon               = -117.18f;
        msg.body.kin.motion.pos.depth                   = 40.0f;
        msg.body.kin.motion.heading                     = 47.0f;
        msg.body.kin.motion.speed_kt                    = 0.0f;
        msg.body.kin.snr                                = 14.2f;
        msg.body.sensor_id                              = 1;
        strcpy(msg.body.label, "HYD-1");

        msg.origin.sin_family      = AF_INET;
        msg.origin.sin_port        = htons(CIC_PICTURE_PORT);
        msg.origin.sin_addr.s_addr = 0x7f000001;

        send_contact(&msg);
        send_enum_tagged(&msg);
        usleep(200000);
    }

    cic_bus_close(g_bus);
    close(g_sock);
    return 0;
}
