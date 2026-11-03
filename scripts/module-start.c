#define _GNU_SOURCE
#include <fcntl.h>
#include <errno.h>
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef ROOT_UID
#define ROOT_UID 0
#endif
#ifndef SERVER_UID
#define SERVER_UID 1001
#endif
#ifndef PRIVATE_ROOT
#define PRIVATE_ROOT "/run/bellteam-maintenance"
#endif
#ifndef STATE_ROOT
#define STATE_ROOT "/srv/bellteam/state"
#endif
#ifndef BUILTIN_ROOT
#define BUILTIN_ROOT "/app"
#endif
#ifndef NODE_BINARY
#define NODE_BINARY "/usr/local/bin/node"
#endif
#ifndef MODULE_NAME
#error MODULE_NAME must be compiled into the fixed entry
#endif
#ifndef MODULE_ENTRY
#error MODULE_ENTRY must be compiled into the fixed entry
#endif
#ifndef MODULE_ERROR
#error MODULE_ERROR must be compiled into the fixed entry
#endif
static int fail(void) { fputs(MODULE_ERROR "\n", stderr); return 126; }
static int same(struct stat *a, struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino; }
int main(int argc, char **argv) {
    if (argc != 2 || getuid() != SERVER_UID || geteuid() != SERVER_UID
        || getgid() != SERVER_UID || getegid() != SERVER_UID) return fail();
    gid_t groups[128]; int count = getgroups(128, groups);
    if (count < 0) return fail();
    for (int i = 0; i < count; i++) if (groups[i] != SERVER_UID) return fail();
    int builtin = strcmp(argv[1], "builtin") == 0;
    if (!builtin && (strlen(argv[1]) != 64 || strspn(argv[1], "0123456789abcdef") != 64)) return fail();
    struct stat channel, info, linked;
    if (fstat(3, &channel) || !S_ISSOCK(channel.st_mode)) return fail();
#ifdef MODULE_PRESERVE_NOTES
    const char *configured_notes = getenv("BELLTEAM_DIAGNOSTIC_INVESTIGATIONS");
    char *notes = configured_notes ? strdup(configured_notes) : NULL;
    if (configured_notes && !notes) return fail();
#endif
    closefrom(4);
    int shared = open(PRIVATE_ROOT, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (shared != 4 || fstat(shared, &info) || info.st_uid != ROOT_UID || info.st_gid != SERVER_UID
        || (info.st_mode & 07777) != 0750 || flock(shared, LOCK_SH | LOCK_NB)
        || lstat(PRIVATE_ROOT, &linked) || !same(&info, &linked)) return fail();
    if (fstatat(shared, ".transaction.json", &linked, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) return fail();
    int state = open(STATE_ROOT, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (state < 0 || fstat(state, &info) || info.st_uid != SERVER_UID || info.st_gid != SERVER_UID) return fail();
    umask(077);
    int writer = openat(state, MODULE_NAME ".lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0600);
    if (writer != 6 || fstat(writer, &info) || !S_ISREG(info.st_mode) || info.st_uid != SERVER_UID
        || info.st_gid != SERVER_UID || info.st_nlink != 1 || (info.st_mode & 07777) != 0600
        || flock(writer, LOCK_EX | LOCK_NB) || fstatat(state, MODULE_NAME ".lock", &linked, AT_SYMLINK_NOFOLLOW)
        || !same(&info, &linked)) return fail();
    if (dup2(writer, 5) != 5) return fail();
    close(writer);
    char root[512], entry[560];
    int size = builtin ? snprintf(root, sizeof(root), "%s", BUILTIN_ROOT)
        : snprintf(root, sizeof(root), "%s/" MODULE_NAME "/releases/%s/payload", PRIVATE_ROOT, argv[1]);
    if (size < 0 || (size_t)size >= sizeof(root) || chdir(root)) return fail();
    if (snprintf(entry, sizeof(entry), "%s/src/" MODULE_ENTRY ".mjs", root) >= (int)sizeof(entry)) return fail();
    if (clearenv() || setenv("PATH", "/usr/local/bin:/usr/bin:/bin", 1)
        || setenv("HOME", "/run/bellteam-server", 1) || setenv("NODE_CHANNEL_FD", "3", 1)
        || setenv("NODE_CHANNEL_SERIALIZATION_MODE", "advanced", 1)) return fail();
#ifdef MODULE_PRESERVE_NOTES
    if (notes && setenv("BELLTEAM_DIAGNOSTIC_INVESTIGATIONS", notes, 1)) return fail();
    free(notes);
#endif
    char *const command[] = { NODE_BINARY, entry, argv[1], NULL };
    execv(command[0], command);
    return fail();
}
