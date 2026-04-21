/*
 * sonar_tracker.c — Sonar ping producer.
 *
 * Tests Strategy A: titan_send_message is called with TITAN_MSG_SONAR_PING
 * as a compile-time constant argument. The tool should extract TITAN_MSG_SONAR_PING
 * from the call and associate it with SonarPingData.
 *
 * Tests Strategy B: send_sonar_ping() takes SonarPingData* as a parameter.
 * The tool should infer SonarPingData from the wrapper function's signature
 * even when msg_id is a constant (both strategies fire here).
 */

#include <string.h>
#include "titan_types.h"

static titan_handle_t g_handle;

/* Strategy B trigger: SonarPingData* parameter + titan_send_message inside */
static void send_sonar_ping(SonarPingData *ping, unsigned int seq)
{
    ping->seq = seq;
    titan_send_message(g_handle, TITAN_MSG_SONAR_PING, sizeof(SonarPingData), ping);
}

/* Strategy A only: called with literal constant, no typed wrapper param */
static void send_heartbeat(void)
{
    unsigned char dummy = 0;
    titan_send_message(g_handle, TITAN_MSG_HEARTBEAT, sizeof(dummy), &dummy);
}

int sonar_tracker_main(void)
{
    SonarPingData ping;

    g_handle = titan_connect("titan://localhost:5100");
    if (!g_handle) return -1;

    ping.bearing      = 45;
    ping.range_meters = 1200;
    ping.confidence   = 0.87f;

    send_sonar_ping(&ping, 1);
    send_heartbeat();

    titan_disconnect(g_handle);
    return 0;
}
