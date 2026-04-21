/*
 * titan_types.h — Types and constants for the TITAN custom IPC bus.
 *
 * TITAN (Tactical Integrated Transport and Notification) is a proprietary
 * message-passing layer that wraps socket transport. Messages are sent
 * via titan_send_message(handle, msg_id, size, data) where msg_id is
 * a runtime constant defined below.
 *
 * This fixture tests Strategy A (constant-argument extraction) and
 * Strategy B (wrapper function parameter analysis).
 */

#ifndef TITAN_TYPES_H
#define TITAN_TYPES_H

/* ── TITAN message IDs — non-standard naming (no MSG_TYPE_ prefix) ─── */
#define TITAN_MSG_SONAR_PING      0x10
#define TITAN_MSG_TARGET_TRACK    0x11
#define TITAN_MSG_WEAPONS_RELEASE 0x12
#define TITAN_MSG_HEARTBEAT       0x13
#define TITAN_MISSING_HEADER_MSG  0xFF  /* intentionally left undefined in consumer */

/* ── TITAN handle — opaque to callers ──────────────────────────────── */
typedef struct titan_handle_s * titan_handle_t;

/* ── Message structs ────────────────────────────────────────────────── */
typedef struct {
    unsigned int    bearing;        /* degrees 0-359 */
    unsigned int    range_meters;
    float           confidence;
    unsigned int    seq;
} SonarPingData;

typedef struct {
    unsigned int    track_id;
    int             x_pos;
    int             y_pos;
    int             x_vel;
    int             y_vel;
    unsigned int    quality;
} TargetTrackData;

typedef struct {
    unsigned int    weapon_id;
    unsigned int    target_track_id;
    unsigned int    fire_solution_flags;
    float           bearing;
    float           range;
} WeaponsReleaseData;

/* ── TITAN API ──────────────────────────────────────────────────────── */
int  titan_send_message(titan_handle_t handle, unsigned int msg_id,
                        unsigned int size, const void *data);
int  titan_recv_message(titan_handle_t handle, unsigned int *msg_id_out,
                        unsigned int *size_out, void *data);
titan_handle_t titan_connect(const char *endpoint);
void titan_disconnect(titan_handle_t handle);

#endif /* TITAN_TYPES_H */
