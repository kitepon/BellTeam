#define _GNU_SOURCE
#include <fcntl.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

/* Fixed, non-privileged server entry. Seat HOME/PATH and Node preload settings
 * are never used to select the server executable or application module. */
static int admission_failed(void) {
    fputs("BELLTEAM_NORMAL_ADMISSION\n", stderr);
    return 126;
}

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
    closefrom(3);
    int parent = open("/run/bellteam-maintenance", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat directory, linked, state_info;
    if (parent < 0 || fstat(parent, &directory) != 0 || directory.st_uid != 0
        || directory.st_gid != 1001 || (directory.st_mode & 07777) != 0750
        || flock(parent, LOCK_SH | LOCK_NB) != 0
        || lstat("/run/bellteam-maintenance", &linked) != 0
        || linked.st_dev != directory.st_dev || linked.st_ino != directory.st_ino) return admission_failed();
    if (parent != 3) {
        if (dup2(parent, 3) < 0) return admission_failed();
        close(parent);
    }
    int state = open("/srv/bellteam/state", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (state < 0 || fstat(state, &state_info) != 0 || state_info.st_uid != 1001
        || state_info.st_gid != 1001 || flock(state, LOCK_EX | LOCK_NB) != 0) return admission_failed();
    if (state != 4) {
        if (dup2(state, 4) < 0) return admission_failed();
        close(state);
    }
    /* These kernel locks live with Node; the fixed seat entry closes both. */
    if (fcntl(3, F_SETFD, 0) != 0 || fcntl(4, F_SETFD, 0) != 0) return admission_failed();
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
