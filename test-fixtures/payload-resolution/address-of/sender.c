/* Ground truth: ipc_send call at line 11 should resolve to NavMsg via address-of strategy (HIGH) */
#include "types.h"

extern int ipc_send(int sock, int msg_id, void *payload, size_t len);

void send_nav_update(int sock, float lat, float lon, float alt)
{
    NavMsg msg;
    msg.lat = lat;
    msg.lon = lon;
    msg.alt = alt;
    ipc_send(sock, MSG_NAV, &msg, sizeof(msg));
}
