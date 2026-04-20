/*
 * broker_egress.c — Delivers routed messages to subscribed clients.
 *
 * Reads from the internal routing queue (populated by broker_ingress) and
 * forwards each message to every subscriber registered for that topic.
 * Subscribers are tracked in a shared subscription table (shared memory
 * written by broker_registry).
 *
 * Known subscribers at runtime:
 *   - WCS (solution_receiver):     subscribed to MSG_TYPE_SOLUTION
 *   - sensor array (cmd_receiver): subscribed to MSG_TYPE_COMMAND
 *
 * Internal data flow:
 *   [broker_ingress] --routing queue--> [broker_egress]     (msg queue, msgrcv)
 *   [broker_egress]  --MSG_TYPE_SOLUTION--> [WCS]           (TCP send)
 *   [broker_egress]  --MSG_TYPE_COMMAND --> [sensor array]  (TCP send)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/msg.h>
#include <sys/shm.h>
#include <sys/ipc.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "broker_types.h"

#define BROKER_ROUTE_MQ_KEY   0x4252
#define BROKER_SUBS_SHM_KEY   0x4253   /* 'BS' — subscription table */
#define BROKER_SUBS_SHM_SIZE  4096

extern int g_broker_running;

typedef struct {
    unsigned int    topic;
    unsigned int    client_id;
    char            host[48];
    unsigned short  port;
    int             active;
} SubscriberEntry;

typedef struct {
    unsigned int      count;
    SubscriberEntry   subs[BROKER_MAX_SUBSCRIBERS];
} SubscriptionTable;

static int                g_route_mq   = -1;
static int                g_subs_shm   = -1;
static SubscriptionTable *g_subs       = NULL;

typedef struct {
    long            mtype;
    unsigned int    topic;
    unsigned char   payload[MAX_PAYLOAD_LEN];
    unsigned int    payload_len;
} RoutingMsg;

static int init_routing_queue(void)
{
    /* Routing queue already created by broker_ingress — open existing */
    g_route_mq = msgget(BROKER_ROUTE_MQ_KEY, 0666);
    return (g_route_mq < 0) ? -1 : 0;
}

static int init_subscription_shm(void)
{
    g_subs_shm = shmget(BROKER_SUBS_SHM_KEY, BROKER_SUBS_SHM_SIZE, 0666);
    if (g_subs_shm < 0) return -1;
    g_subs = (SubscriptionTable *)shmat(g_subs_shm, NULL, SHM_RDONLY);
    return (g_subs == (void *)-1) ? -1 : 0;
}

static int open_subscriber_socket(const SubscriberEntry *sub)
{
    struct sockaddr_in addr;
    int fd;

    fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(sub->port);
    inet_aton(sub->host, &addr.sin_addr);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

static void deliver_to_subscribers(unsigned int topic,
                                    const unsigned char *payload,
                                    unsigned int payload_len)
{
    unsigned int i;

    for (i = 0; i < g_subs->count; i++) {
        const SubscriberEntry *sub = &g_subs->subs[i];

        if (!sub->active || sub->topic != topic) continue;

        int fd = open_subscriber_socket(sub);
        if (fd < 0) {
            fprintf(stderr, "broker_egress: cannot reach client %u for topic 0x%02x\n",
                    sub->client_id, topic);
            continue;
        }

        if (send(fd, payload, payload_len, 0) < 0) {
            perror("broker_egress: send");
        }

        close(fd);
    }
}

int broker_egress_main(void)
{
    RoutingMsg rmsg;

    if (init_routing_queue() != 0) {
        perror("broker_egress: msgget route queue");
        return -1;
    }

    if (init_subscription_shm() != 0) {
        perror("broker_egress: shmget subs");
        return -1;
    }

    while (g_broker_running) {
        /*
         * Block until a routed message arrives.  The mtype field in RoutingMsg
         * carries the topic (msg_type constant), so msgrcv with mtype=0 receives
         * any topic in arrival order.
         */
        if (msgrcv(g_route_mq, &rmsg, sizeof(RoutingMsg) - sizeof(long),
                   0, MSG_NOERROR) < 0) {
            continue;
        }

        switch (rmsg.topic) {
        case MSG_TYPE_SOLUTION:
            fprintf(stderr, "broker_egress: routing MSG_TYPE_SOLUTION to subscribers\n");
            deliver_to_subscribers(MSG_TYPE_SOLUTION, rmsg.payload, rmsg.payload_len);
            break;

        case MSG_TYPE_COMMAND:
            fprintf(stderr, "broker_egress: routing MSG_TYPE_COMMAND to subscribers\n");
            deliver_to_subscribers(MSG_TYPE_COMMAND, rmsg.payload, rmsg.payload_len);
            break;

        default:
            fprintf(stderr, "broker_egress: unroutable topic 0x%02x\n", rmsg.topic);
            break;
        }
    }

    shmdt(g_subs);
    return 0;
}
