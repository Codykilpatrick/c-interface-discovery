/*
 * wcs_supervisor.c — WCS process lifecycle and signal management.
 *
 * Mirrors the role of signal_handler.c in the sensor array.
 * Handles SIGTERM/SIGINT for clean shutdown, forks and monitors all WCS
 * child processes (solution_receiver, target_tracker, weapons_director,
 * wcs_console), and restarts them on unexpected exit.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <sys/wait.h>
#include "wcs_types.h"

int g_wcs_running = 1;

static const char *PROC_SOLUTION  = "./solution_receiver";
static const char *PROC_TRACKER   = "./target_tracker";
static const char *PROC_DIRECTOR  = "./weapons_director";
static const char *PROC_CONSOLE   = "./wcs_console";

static void on_shutdown(int signum)
{
    (void)signum;
    g_wcs_running = 0;
}

static void on_child(int signum)
{
    int status;
    (void)signum;
    waitpid(-1, &status, WNOHANG);
}

static pid_t spawn(const char *path)
{
    pid_t pid = fork();
    if (pid == 0) {
        char *argv[] = { (char *)path, NULL };
        execv(path, argv);
        perror("execv");
        exit(1);
    }
    return pid;
}

static void watchdog_loop(void)
{
    pid_t pid_sol, pid_trk, pid_dir, pid_con;
    int status;

    pid_sol = spawn(PROC_SOLUTION);
    pid_trk = spawn(PROC_TRACKER);
    pid_dir = spawn(PROC_DIRECTOR);
    pid_con = spawn(PROC_CONSOLE);

    while (g_wcs_running) {
        pid_t dead = waitpid(-1, &status, WNOHANG);

        if      (dead == pid_sol) { sleep(1); pid_sol = spawn(PROC_SOLUTION); }
        else if (dead == pid_trk) { sleep(1); pid_trk = spawn(PROC_TRACKER);  }
        else if (dead == pid_dir) { sleep(1); pid_dir = spawn(PROC_DIRECTOR); }
        else if (dead == pid_con) { sleep(1); pid_con = spawn(PROC_CONSOLE);  }

        sleep(1);
    }

    kill(pid_sol, SIGTERM);
    kill(pid_trk, SIGTERM);
    kill(pid_dir, SIGTERM);
    kill(pid_con, SIGTERM);
}

int main(void)
{
    struct sigaction sa_term, sa_chld;

    sa_term.sa_handler = on_shutdown;
    sigemptyset(&sa_term.sa_mask);
    sa_term.sa_flags = 0;
    sigaction(SIGTERM, &sa_term, NULL);
    sigaction(SIGINT,  &sa_term, NULL);

    sa_chld.sa_handler = on_child;
    sigemptyset(&sa_chld.sa_mask);
    sa_chld.sa_flags = SA_RESTART;
    sigaction(SIGCHLD, &sa_chld, NULL);

    watchdog_loop();
    return 0;
}
