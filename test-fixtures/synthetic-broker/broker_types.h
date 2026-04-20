/*
 * broker_types.h — Message Broker protocol definitions.
 *
 * The broker sits between the acoustic sensor array and the weapons control
 * system (WCS).  Neither application speaks to the other directly — both
 * publish messages to the broker, which routes them to registered subscribers.
 *
 * Shared protocol constants (must match acoustic_types.h / wcs_types.h):
 *   MSG_TYPE_SOLUTION (0x06) — produced by sensor array, forwarded to WCS
 *   MSG_TYPE_COMMAND  (0x03) — produced by WCS, forwarded to sensor array
 *
 * Broker-internal message types (0x20+) are not visible to either client app.
 */

#ifndef BROKER_TYPES_H
#define BROKER_TYPES_H

/* ── Shared protocol constants (values must match client applications) ──────── */

#define MSG_TYPE_SOLUTION    0x06
#define MSG_TYPE_COMMAND     0x03

#define MAX_PAYLOAD_LEN      512

typedef struct {
    unsigned int    msg_type;
    unsigned int    seq_num;
    unsigned int    payload_len;
    unsigned char   checksum;
} MsgHeader;

/* ── Broker-internal types ──────────────────────────────────────────────────── */

#define MSG_TYPE_BROKER_SUBSCRIBE   0x20   /* client registers a topic subscription */
#define MSG_TYPE_BROKER_UNSUBSCRIBE 0x21   /* client deregisters                    */
#define MSG_TYPE_BROKER_ACK         0x22   /* broker confirms delivery              */
#define MSG_TYPE_BROKER_LOG         0x23   /* internal audit log entry              */

typedef struct {
    MsgHeader       header;
    unsigned int    topic;              /* msg_type the client is subscribing to */
    unsigned int    client_id;
    char            endpoint[64];       /* "host:port" to deliver routed messages */
} BrokerSubscribeMsg;

typedef struct {
    MsgHeader       header;
    unsigned int    topic;
    unsigned int    delivered_seq;
    unsigned int    subscriber_count;
} BrokerAckMsg;

typedef struct {
    MsgHeader       header;
    unsigned int    topic;
    unsigned int    source_client;
    unsigned int    dest_count;
    char            note[64];
} BrokerLogMsg;

/* ── Network constants ──────────────────────────────────────────────────────── */

#define BROKER_INGEST_PORT      6000    /* all publishers connect here to send */
#define BROKER_SUBSCRIBE_PORT   6001    /* clients register subscriptions here */
#define BROKER_LOG_PORT         6002    /* internal log/audit sink             */

#define BROKER_MAX_SUBSCRIBERS  32
#define BROKER_MAX_TOPICS       16

#endif /* BROKER_TYPES_H */
