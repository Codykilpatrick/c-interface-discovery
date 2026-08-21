/*
 * supervisor.c — Process lifecycle for the CIC string.
 *
 * Forks a watchdog, installs signal handlers, and creates the auth FIFO.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <semaphore.h>
#include "cic_types.h"

int g_cic_running = 1;

static const char *g_watchdog_argv[] = { CIC_WATCHDOG_BIN, NULL };
static sem_t      *g_ready = NULL;

static void on_term(int signum)
{
    (void)signum;
    g_cic_running = 0;
}

static pid_t spawn_watchdog(void)
{
    pid_t pid = fork();
    if (pid == 0) {
        execv(CIC_WATCHDOG_BIN, (char *const *)g_watchdog_argv);
        perror("execv");
        exit(1);
    }
    return pid;
}

int supervisor_main(void)
{
    struct sigaction sa;
    pid_t child;
    int pipefd[2];

    sa.sa_handler = on_term;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT,  &sa, NULL);

    mkfifo(CIC_AUTH_PIPE, 0666);
    pipe(pipefd);
    close(pipefd[0]);
    close(pipefd[1]);

    g_ready = sem_open("/cic_ready", O_CREAT, 0666, 0);
    sem_post(g_ready);

    child = spawn_watchdog();
    while (g_cic_running) {
        waitpid(child, NULL, WNOHANG);
        sleep(1);
    }

    kill(child, SIGTERM);
    sem_close(g_ready);
    return 0;
}
