#define _GNU_SOURCE
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

/* Fixed, non-privileged server entry. Seat HOME/PATH and Node preload settings
 * are never used to select the server executable or application module. */
int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1 || getuid() != 1001 || geteuid() != 1001
        || getgid() != 1001 || getegid() != 1001) {
        fputs("BELLTEAM_SERVER_IDENTITY\n", stderr);
        return 126;
    }
    gid_t groups[128];
    int count = getgroups(128, groups);
    if (count < 0) return 126;
    for (int i = 0; i < count; i++) if (groups[i] != 1001) return 126;
    const char *remove[] = {"NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", NULL};
    for (int i = 0; remove[i]; i++) if (unsetenv(remove[i]) != 0) return 126;
    if (setenv("HOME", "/run/bellteam-server", 1) != 0
        || setenv("BELLTEAM_HOME", "/home/bell", 1) != 0
        || setenv("PATH", "/usr/local/bin:/usr/bin:/bin", 1) != 0
        || chdir("/app") != 0) return 126;
    char *const command[] = {"/usr/local/bin/node", "/app/src/supervisor.mjs", NULL};
    execv(command[0], command);
    fputs("BELLTEAM_SERVER_EXEC_FAILED\n", stderr);
    return 126;
}
