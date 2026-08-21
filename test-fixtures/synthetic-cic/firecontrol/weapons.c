/*
 * weapons.c — Publishes MSG_TYPE_WEAPON_ORD with no consumer in this suite.
 *
 * dispatch() takes a runtime msg id and void* payload — unresolved for
 * payload resolution. malloc() without free.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "fc_types.h"

int g_fc_running = 1;

static cic_bus_t g_bus  = NULL;
static int       g_sock = -1;
static unsigned int g_seq = 0;

static void dispatch(unsigned int msg_id, void *payload, unsigned int len)
{
    cic_bus_send(g_bus, msg_id, len, payload);
    send(g_sock, payload, len, 0);
}

int weapons_main(void)
{
    struct sockaddr_in addr;
    WeaponOrdMsg *ord;

    g_bus = cic_bus_connect(CIC_BUS_ENDPOINT);
    if (!g_bus) return -1;

    g_sock = socket(AF_INET, SOCK_DGRAM, 0);
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(FC_WEAPON_PORT);
    inet_aton("127.0.0.1", &addr.sin_addr);
    connect(g_sock, (struct sockaddr *)&addr, sizeof(addr));

    ord = (WeaponOrdMsg *)malloc(sizeof(WeaponOrdMsg));
    memset(ord, 0, sizeof(*ord));
    ord->hdr.msg_type = MSG_TYPE_WEAPON_ORD;
    ord->hdr.length   = sizeof(WeaponOrdMsg);
    ord->hdr.seq      = g_seq++;
    ord->tube_id      = 2;
    ord->track_id     = 100;
    ord->weapon_type  = 1;

    while (g_fc_running) {
        char status[64];
        sprintf(status, "tube %u track %u", ord->tube_id, ord->track_id);
        (void)status;
        dispatch(MSG_TYPE_WEAPON_ORD, ord, sizeof(WeaponOrdMsg));
        usleep(1000000);
    }

    cic_bus_close(g_bus);
    close(g_sock);
    return 0;
}
