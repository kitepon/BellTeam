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
    struct stat directory, held, linked;
    if (parent < 0 || fstat(parent, &directory) != 0 || directory.st_uid != 0
        || directory.st_gid != 1001 || (directory.st_mode & 07777) != 0750) return admission_failed();
    int lock = openat(parent, "sec014.lock", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (lock < 0 || fstat(lock, &held) != 0 || !S_ISREG(held.st_mode)
        || held.st_uid != 0 || held.st_gid != 1001 || held.st_nlink != 1
        || (held.st_mode & 07777) != 0640 || flock(lock, LOCK_SH | LOCK_NB) != 0
        || fstatat(parent, "sec014.lock", &linked, AT_SYMLINK_NOFOLLOW) != 0
        || linked.st_dev != held.st_dev || linked.st_ino != held.st_ino) return admission_failed();
    close(parent);
    /* FD 3 owns the same-inode SH until Node exits, including its first imports. */
    if (lock != 3) {
        if (dup2(lock, 3) < 0) return admission_failed();
        close(lock);
    }
    if (fcntl(3, F_SETFD, 0) != 0) return admission_failed();
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
