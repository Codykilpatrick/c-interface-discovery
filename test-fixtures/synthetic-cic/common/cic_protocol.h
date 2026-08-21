/*
 * cic_protocol.h — Shared combat-system protocol.
 *
 * Drop synthetic-cic/common/ and synthetic-cic/usr/include/ into External Includes.
 *
 *   ContactMsg.body                    fused_contact.h          (app)
 *     .kin                             track_kinematics.h       (app)
 *       .motion                        motion.h                 (app)
 *         .pos  (DepthFixAlias)        depth_fix.h              (app)
 *           .horiz                     geo_coord.h              (app)
 *             .when                    time_stamp.h             (app)
 *               .wall                  sys/time.h timeval       (usr/include)
 *                 .tv_sec              bits/types.h __time_t
 *   ContactMsg.origin                  netinet/in.h sockaddr_in (usr/include)
 *     .sin_addr                        netinet/in.h in_addr
 *       .s_addr                        bits/types.h __be32
 *
 * Cross-application messages:
 *   MSG_TYPE_CONTACT    sonar → CIC
 *   MSG_TYPE_OWN_SHIP   nav → CIC
 *   MSG_TYPE_TRACK      sonar → CIC (transit) → fire control
 *   MSG_TYPE_ENGAGE     fire control → CIC
 *   MSG_TYPE_WEAPON_ORD fire control → (no consumer)
 *   MSG_TYPE_HEARTBEAT  CIC internal
 *   MSG_ID_NAV_FIX      nav internal (fifo)
 *   PKT_TYPE_LINK_REPORT CIC → Link-11 (import cid-config.json)
 */

#ifndef CIC_PROTOCOL_H
#define CIC_PROTOCOL_H

#include <netinet/in.h>
#include "fused_contact.h"

#define MSG_TYPE_CONTACT      0x30
#define MSG_TYPE_OWN_SHIP     0x31
#define MSG_TYPE_TRACK        0x32
#define MSG_TYPE_ENGAGE       0x33
#define MSG_TYPE_WEAPON_ORD   0x34
#define MSG_TYPE_HEARTBEAT    0x35
#define MSG_ID_NAV_FIX        0x40
#define PKT_TYPE_LINK_REPORT  0x50

#define CIC_MAX_PAYLOAD       1024
#define CIC_MAX_TRACKS        32
#define CIC_BUS_ENDPOINT      "127.0.0.1"
#define CIC_PICTURE_PORT      7100
#define CIC_TRACK_PORT        7101
#define CIC_ENGAGE_PORT       7102
#define SONAR_TRACK_PORT      7200
#define NAV_OWN_SHIP_PORT     7300
#define FC_ENGAGE_PORT        7400
#define FC_WEAPON_PORT        7401

#define CIC_SHM_KEY           0x4349
#define CIC_SHM_SIZE          8192
#define CIC_MQ_KEY            0x434D
#define CIC_SEM_KEY           0x4353

typedef struct {
    unsigned short  msg_type;
    unsigned short  length;
    unsigned int    seq;
    unsigned char   checksum;
} CicHeader;

typedef struct {
    CicHeader           hdr;
    FusedContact        body;
    struct sockaddr_in  origin;     /* system type from netinet/in.h */
} ContactMsg;

typedef struct {
    CicHeader       hdr;
    MotionState     motion;
    unsigned int    fix_quality;
} OwnShipMsg;

typedef struct {
    CicHeader       hdr;
    unsigned int    track_id;
    TrackKinematics kin;
    unsigned int    source;     /* 0 = sonar, 1 = link */
} TrackMsg;

typedef struct {
    CicHeader       hdr;
    unsigned int    track_id;
    unsigned int    weapon_id;
    unsigned int    auth_flags;
    TrackKinematics aim;
} EngageMsg;

typedef struct {
    CicHeader       hdr;
    unsigned int    tube_id;
    unsigned int    track_id;
    unsigned int    weapon_type;
} WeaponOrdMsg;

typedef struct {
    CicHeader       hdr;
    unsigned int    n_tracks;
    unsigned int    own_ship_seq;
    char            note[64];
} LinkReportPkt;

typedef struct {
    CicHeader       hdr;
    unsigned int    origin;
} HeartbeatMsg;

typedef enum {
    CIC_BUS_CONTACT = 0x30,
    CIC_BUS_TRACK   = 0x32,
    CIC_BUS_ENGAGE  = 0x33
} CicBusMsgId;

#endif /* CIC_PROTOCOL_H */
