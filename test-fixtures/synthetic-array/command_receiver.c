/*
 * command_receiver.c — Operator command interface process.
 *
 * Listens for CommandMsg on a dedicated TCP port. Commands originate from
 * the external operator console — no source for the console process is
 * present in this array. MSG_TYPE_COMMAND edges in the interface graph
 * will show as unknown producer (? External).
 *
 * Supported commands:
 *   CMD_SET_GAIN     — adjust sensor gain
 *   CMD_SET_RATE     — adjust sample rate
 *   CMD_RESET        — trigger sensor reset via status message
 *   CMD_SHUTDOWN     — orderly shutdown of the array
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include "acoustic_types.h"
#include "sensor_defs.h"

#define CMD_PORT        5200
#define CMD_SET_GAIN    0x01
#define CMD_SET_RATE    0x02
#define CMD_RESET       0x03
#define CMD_SHUTDOWN    0xFF

extern int          g_running;
extern SensorState  g_sensor_state;

static int g_cmd_fd     = -1;
static int g_client_fd  = -1;
static unsigned int g_seq = 0;

static int init_cmd_listener(void)
{
    struct sockaddr_in addr;
    int opt = 1;

    g_cmd_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (g_cmd_fd < 0) return -1;

    setsockopt(g_cmd_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port        = htons(CMD_PORT);

    if (bind(g_cmd_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) return -1;
    return listen(g_cmd_fd, 2);
}

static void apply_command(const CommandMsg *cmd)
{
    switch (cmd->command_id) {
    case CMD_SET_GAIN:
        g_sensor_state.config.gain = (float)cmd->param1 / 100.0f;
        fprintf(stderr, "command_receiver: gain set to %.2f\n",
                g_sensor_state.config.gain);
        break;

    case CMD_SET_RATE:
        if (cmd->param1 > 0 && cmd->param1 <= 1000) {
            g_sensor_state.config.sample_rate = cmd->param1;
            fprintf(stderr, "command_receiver: rate set to %u Hz\n", cmd->param1);
        }
        break;

    case CMD_RESET:
        fprintf(stderr, "command_receiver: reset requested\n");
        /* supervisor_send_reload() triggers config re-read across processes */
        supervisor_send_reload();
        break;

    case CMD_SHUTDOWN:
        fprintf(stderr, "command_receiver: shutdown command received\n");
        g_running = 0;
        break;

    default:
        fprintf(stderr, "command_receiver: unknown command id 0x%02x\n",
                cmd->command_id);
        break;
    }
}

static void command_loop(int fd)
{
    unsigned char buf[sizeof(CommandMsg)];
    int n;

    while (g_running) {
        n = recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) break;

        if ((unsigned int)n < sizeof(MsgHeader)) continue;

        const MsgHeader *hdr = (const MsgHeader *)buf;
        if (hdr->msg_type != MSG_TYPE_COMMAND) {
            fprintf(stderr, "command_receiver: unexpected msg_type 0x%02x\n",
                    hdr->msg_type);
            continue;
        }

        if ((unsigned int)n < sizeof(CommandMsg)) continue;
        apply_command((const CommandMsg *)buf);
    }
}

int command_receiver_main(void)
{
    if (init_cmd_listener() != 0) {
        fprintf(stderr, "command_receiver: bind failed\n");
        return -1;
    }

    while (g_running) {
        g_client_fd = accept(g_cmd_fd, NULL, NULL);
        if (g_client_fd < 0) continue;
        command_loop(g_client_fd);
        close(g_client_fd);
    }

    close(g_cmd_fd);
    return 0;
}
