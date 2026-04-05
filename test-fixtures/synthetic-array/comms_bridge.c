/*
 * comms_bridge.c — Communications Multiplexer bridge process.
 *
 * Listens for messages from HYDRA sensor processes over TCP, deserializes
 * them, writes acoustic data into shared memory for the fire control array,
 * and forwards status/alarm messages over a message queue to the supervisor.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/shm.h>
#include <sys/ipc.h>
#include <sys/msg.h>
#include <netinet/in.h>
#include "acoustic_types.h"
#include "sensor_defs.h"

extern int g_running;

static int       g_listen_fd  = -1;
static int       g_client_fd  = -1;
static int       g_shm_id     = -1;
static int       g_mq_id      = -1;
static void     *g_shm_ptr    = NULL;

typedef struct {
    long         mtype;
    unsigned int alarm_code;
    unsigned int severity;
    char         description[128];
} SupervisorMqMsg;

static int init_listener(void)
{
    struct sockaddr_in addr;
    int opt = 1;

    g_listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (g_listen_fd < 0) return -1;

    setsockopt(g_listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port        = htons(COMMS_BRIDGE_PORT);

    if (bind(g_listen_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) return -1;
    return listen(g_listen_fd, 4);
}

static int init_shared_memory(void)
{
    g_shm_id = shmget(SHM_KEY_ACOUSTIC, SHM_SEGMENT_SIZE, IPC_CREAT | 0666);
    if (g_shm_id < 0) return -1;
    g_shm_ptr = shmat(g_shm_id, NULL, 0);
    return (g_shm_ptr == (void *)-1) ? -1 : 0;
}

static int init_message_queue(void)
{
    g_mq_id = msgget(SHM_KEY_STATUS, IPC_CREAT | 0666);
    return (g_mq_id < 0) ? -1 : 0;
}

static void handle_acoustic(const AcousticMsg *msg)
{
    if (g_shm_ptr == NULL) return;

    /* Write latest acoustic sample into shared memory for fire control */
    memcpy(g_shm_ptr, &msg->sample, sizeof(AcousticSample));

    /* Notify downstream consumers via custom dispatch */
    comms_dispatch(MSG_TYPE_ACOUSTIC, g_shm_ptr, sizeof(AcousticSample));
}

static void handle_status(const StatusMsg *msg)
{
    /* Forward status to supervisor via custom logging layer */
    comms_log_status(msg->sensor_id, msg->status_flags, msg->status_text);
}

static void handle_alarm(const AlarmMsg *msg)
{
    SupervisorMqMsg qmsg;
    qmsg.mtype       = 1;
    qmsg.alarm_code  = msg->alarm_code;
    qmsg.severity    = msg->severity;
    memcpy(qmsg.description, msg->description, sizeof(qmsg.description));

    msgsnd(g_mq_id, &qmsg, sizeof(qmsg) - sizeof(long), 0);

    /* Also dispatch to any registered alarm handlers */
    comms_dispatch(MSG_TYPE_ALARM, msg, sizeof(AlarmMsg));
}

static void process_message(const unsigned char *buf, unsigned int len)
{
    const MsgHeader *hdr;

    if (len < sizeof(MsgHeader)) return;
    hdr = (const MsgHeader *)buf;

    switch (hdr->msg_type) {
    case MSG_TYPE_ACOUSTIC:
        if (len >= sizeof(AcousticMsg))
            handle_acoustic((const AcousticMsg *)buf);
        break;
    case MSG_TYPE_STATUS:
        if (len >= sizeof(StatusMsg))
            handle_status((const StatusMsg *)buf);
        break;
    case MSG_TYPE_ALARM:
        if (len >= sizeof(AlarmMsg))
            handle_alarm((const AlarmMsg *)buf);
        break;
    case MSG_TYPE_HEARTBEAT:
        comms_log_status(0, 0, "heartbeat");
        break;
    default:
        fprintf(stderr, "comms_bridge: unknown msg_type 0x%02x\n", hdr->msg_type);
        break;
    }
}

static void receive_loop(int fd)
{
    unsigned char buf[MAX_PAYLOAD_LEN];
    int n;

    while (g_running) {
        n = recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) break;
        process_message(buf, (unsigned int)n);
    }
}

int comms_bridge_main(void)
{
    if (init_listener()      != 0) { perror("listener"); return -1; }
    if (init_shared_memory() != 0) { perror("shm");      return -1; }
    if (init_message_queue() != 0) { perror("mq");       return -1; }

    while (g_running) {
        g_client_fd = accept(g_listen_fd, NULL, NULL);
        if (g_client_fd < 0) continue;
        receive_loop(g_client_fd);
        close(g_client_fd);
    }

    shmdt(g_shm_ptr);
    shmctl(g_shm_id, IPC_RMID, NULL);
    close(g_listen_fd);
    return 0;
}
