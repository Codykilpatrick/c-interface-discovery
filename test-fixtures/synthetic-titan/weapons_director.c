/*
 * weapons_director.c — Weapons release consumer + track consumer.
 *
 * Tests Strategy A consumer side: titan_recv_message produces message IDs
 * at runtime (stored in msg_id variable), so no Strategy A extraction.
 *
 * Tests Strategy B consumer side: recv_target_track(TargetTrackData*) and
 * recv_weapons_release(WeaponsReleaseData*) are typed wrapper functions —
 * the tool infers the struct from the wrapper parameter.
 *
 * Also tests the "missing header" case: references TITAN_MISSING_HEADER_MSG
 * directly in a send call — this constant should be flagged if its definition
 * is not in any loaded header.
 */

#include <string.h>
#include "titan_types.h"

static titan_handle_t g_track_handle;
static titan_handle_t g_weapons_handle;

/* Strategy B: TargetTrackData* parameter → infer struct */
static int recv_target_track(TargetTrackData *track)
{
    unsigned int msg_id = 0, size = 0;
    int rc = titan_recv_message(g_track_handle, &msg_id, &size, track);
    if (rc < 0) return -1;
    return (msg_id == TITAN_MSG_TARGET_TRACK) ? 0 : -1;
}

/* Strategy B: WeaponsReleaseData* parameter → infer struct */
static int recv_weapons_release(WeaponsReleaseData *release)
{
    unsigned int msg_id = 0, size = 0;
    return titan_recv_message(g_weapons_handle, &msg_id, &size, release);
}

/* Strategy A: TITAN_MSG_WEAPONS_RELEASE used as literal constant on send side */
static void send_fire_confirm(const WeaponsReleaseData *confirm)
{
    titan_send_message(g_weapons_handle, TITAN_MSG_WEAPONS_RELEASE,
                       sizeof(WeaponsReleaseData), confirm);
}

int weapons_director_main(void)
{
    TargetTrackData    track;
    WeaponsReleaseData release;

    g_track_handle   = titan_connect("titan://localhost:5101");
    g_weapons_handle = titan_connect("titan://localhost:5102");

    if (!g_track_handle || !g_weapons_handle) return -1;

    while (1) {
        if (recv_target_track(&track) == 0) {
            if (track.quality > 80) {
                if (recv_weapons_release(&release) == 0) {
                    send_fire_confirm(&release);
                }
            }
        }
    }

    titan_disconnect(g_track_handle);
    titan_disconnect(g_weapons_handle);
    return 0;
}
