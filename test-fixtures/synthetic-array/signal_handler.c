/*
 * signal_handler.c — Process lifecycle and signal management.
 *
 * Handles SIGTERM/SIGINT for clean shutdown, SIGHUP for config reload,
 * and forks the watchdog subprocess that restarts sensor processes on failure.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <sys/wait.h>
#include "sensor_defs.h"

int g_running = 1;

static const char *g_sensor_argv[] = { "./hydra_sensor", NULL };
static const char *g_bridge_argv[] = { "./comms_bridge",  NULL };

static void on_shutdown(int signum)
{
    (void)signum;
    g_running = 0;
}

static void on_reload(int signum)
{
    (void)signum;
    /* Signal the bridge to re-read config — custom IPC wrapper */
    supervisor_send_reload();
}

static void on_child(int signum)
{
    int status;
    (void)signum;
    waitpid(-1, &status, WNOHANG);
}

static pid_t spawn_process(const char *path, const char *const argv[])
{
    pid_t pid = fork();
    if (pid == 0) {
        execv(path, (char *const *)argv);
        perror("execv");
        exit(1);
    }
    return pid;
}

static void watchdog_loop(void)
{
    pid_t sensor_pid, bridge_pid;
    int status;

    sensor_pid = spawn_process(g_sensor_argv[0], g_sensor_argv);
    bridge_pid = spawn_process(g_bridge_argv[0], g_bridge_argv);

    while (g_running) {
        pid_t dead = waitpid(-1, &status, WNOHANG);
        if (dead == sensor_pid) {
            /* Sensor died — restart after brief delay */
            sleep(1);
            sensor_pid = spawn_process(g_sensor_argv[0], g_sensor_argv);
            supervisor_send_reload();
        } else if (dead == bridge_pid) {
            sleep(1);
            bridge_pid = spawn_process(g_bridge_argv[0], g_bridge_argv);
        }
        sleep(1);
    }

    kill(sensor_pid, SIGTERM);
    kill(bridge_pid, SIGTERM);
}

int supervisor_main(void)
{
    struct sigaction sa_term, sa_hup, sa_chld;

    sa_term.sa_handler = on_shutdown;
    sigemptymask(&sa_term.sa_mask);
    sa_term.sa_flags = 0;
    sigaction(SIGTERM, &sa_term, NULL);
    sigaction(SIGINT,  &sa_term, NULL);

    sa_hup.sa_handler = on_reload;
    sigemptymask(&sa_hup.sa_mask);
    sa_hup.sa_flags = 0;
    sigaction(SIGHUP, &sa_hup, NULL);

    sa_chld.sa_handler = on_child;
    sigemptymask(&sa_chld.sa_mask);
    sa_chld.sa_flags = SA_RESTART;
    sigaction(SIGCHLD, &sa_chld, NULL);

    watchdog_loop();
    return 0;
}
