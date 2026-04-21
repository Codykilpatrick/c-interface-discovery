/*
 * sonar_tracker.c — Sonar ping producer.
 *
 * Tests Strategy A: slemr_send_message is called with SLEMR_MSG_SONAR_PING
 * as a compile-time constant argument. The tool should extract SLEMR_MSG_SONAR_PING
 * from the call and associate it with SonarPingData.
 *
 * Tests Strategy B: send_sonar_ping() takes SonarPingData* as a parameter.
 * The tool should infer SonarPingData from the wrapper function's signature
 * even when msg_id is a constant (both strategies fire here).
 */

#include <string.h>
#include "slemr_types.h"

static slemr_handle_t g_handle;

/* Strategy B trigger: SonarPingData* parameter + slemr_send_message inside */
static void send_sonar_ping(SonarPingData *ping, unsigned int seq)
{
    ping->seq = seq;
    slemr_send_message(g_handle, SLEMR_MSG_SONAR_PING, sizeof(SonarPingData), ping);
}

/* Strategy A only: called with literal constant, no typed wrapper param */
static void send_heartbeat(void)
{
    unsigned char dummy = 0;
    slemr_send_message(g_handle, SLEMR_MSG_HEARTBEAT, sizeof(dummy), &dummy);
}

int sonar_tracker_main(void)
{
    SonarPingData ping;

    g_handle = slemr_connect("slemr://localhost:5100");
    if (!g_handle) return -1;

    ping.bearing      = 45;
    ping.range_meters = 1200;
    ping.confidence   = 0.87f;

    send_sonar_ping(&ping, 1);
    send_heartbeat();

    slemr_disconnect(g_handle);
    return 0;
}
