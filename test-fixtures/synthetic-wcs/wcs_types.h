/*
 * wcs_types.h — Message types and structs for the Weapons Control System (WCS).
 *
 * The WCS is a separate application from the acoustic sensor array.  Two
 * message types are shared across the application boundary:
 *
 *   MSG_TYPE_SOLUTION (0x06) — produced by fire_control in the sensor array,
 *     received here by solution_receiver.  Values MUST match acoustic_types.h.
 *
 *   MSG_TYPE_COMMAND (0x03) — produced here by weapons_director, consumed by
 *     command_receiver in the sensor array.  Values MUST match acoustic_types.h.
 *
 * WCS-internal message types (0x10–0x1F) are not known to the sensor array.
 */

#ifndef WCS_TYPES_H
#define WCS_TYPES_H

/* ── Shared types (must match acoustic_types.h in the sensor array) ────────── */

#define MSG_TYPE_SOLUTION    0x06   /* cross-app: sensor array → WCS             */
#define MSG_TYPE_COMMAND     0x03   /* cross-app: WCS → sensor array             */

#define MAX_PAYLOAD_LEN      512

typedef struct {
    unsigned int    msg_type;
    unsigned int    seq_num;
    unsigned int    payload_len;
    unsigned char   checksum;
} MsgHeader;

typedef struct {
    MsgHeader       header;
    unsigned int    target_bearing;   /* degrees */
    unsigned int    target_range;     /* meters  */
    float           confidence;       /* 0.0 – 1.0 */
    unsigned int    solution_flags;
} SolutionMsg;

typedef struct {
    MsgHeader       header;
    unsigned int    command_id;
    unsigned int    param1;
    unsigned int    param2;
} CommandMsg;

/* ── WCS-internal message types ─────────────────────────────────────────────── */

#define MSG_TYPE_TARGET_LOCK    0x10   /* bearing/range confirmed, track active   */
#define MSG_TYPE_LAUNCH_AUTH    0x11   /* command authority authorises release    */
#define MSG_TYPE_WEAPON_STATUS  0x12   /* tube ready/fired/fault status           */

typedef struct {
    MsgHeader       header;
    unsigned int    track_id;
    unsigned int    bearing;        /* degrees */
    unsigned int    range;          /* meters  */
    float           confidence;
    unsigned int    lock_flags;     /* LOCK_CONFIRMED 0x01, LOCK_STALE 0x02 */
} TargetLockMsg;

typedef struct {
    MsgHeader       header;
    unsigned int    track_id;
    unsigned int    weapon_tube;    /* 1-based tube number */
    unsigned int    auth_code;      /* keyed auth token from console */
    unsigned int    auth_flags;     /* AUTH_CAPTAIN 0x01, AUTH_XO 0x02 */
} LaunchAuthMsg;

typedef struct {
    MsgHeader       header;
    unsigned int    tube_id;
    unsigned int    weapon_type;
    unsigned int    status_flags;   /* READY 0x01, ARMED 0x02, FIRED 0x04, FAULT 0x08 */
    char            status_text[64];
} WeaponStatusMsg;

/* ── WCS network constants ──────────────────────────────────────────────────── */

#define WCS_SOLUTION_PORT    5100    /* listens for MSG_TYPE_SOLUTION from fire_control */
#define WCS_CONSOLE_PORT     5300    /* listens for MSG_TYPE_LAUNCH_AUTH from captain console */
#define SENSOR_CMD_PORT      5200    /* sends MSG_TYPE_COMMAND to command_receiver */
#define SENSOR_CMD_ADDR      "127.0.0.1"

#define WCS_MQ_KEY           0x5743   /* 'WC' — message queue for internal routing */
#define WCS_PIPE_AUTH        "/tmp/wcs_auth_pipe"

/* Track quality thresholds */
#define LOCK_CONFIDENCE_MIN  0.70f
#define LOCK_STALE_SEC       10

#endif /* WCS_TYPES_H */
