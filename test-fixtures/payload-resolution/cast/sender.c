/* Ground truth: ipc_send call should resolve to RadarMsg via cast strategy (MEDIUM) */
#include "types.h"

extern int ipc_send(int sock, int msg_id, void *payload, unsigned int len);

void send_radar_track(int sock, void *raw_buf)
{
    /* Explicit cast to RadarMsg* — strategy detects the cast_expression type */
    ipc_send(sock, MSG_RADAR, (RadarMsg *)raw_buf, sizeof(RadarMsg));
}
