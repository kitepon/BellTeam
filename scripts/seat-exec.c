#define _GNU_SOURCE
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <unistd.h>

/* Root-installed entry, invoked through a command-scoped sudo rule.
 * Arguments are passed to the seat command only after all UID/GID slots change.
 * No shell, PATH lookup, project file, or Node configuration runs as root.
 * This is the agreed accident boundary; the seat's existing sudo grant remains.
 */
static int fail(const char *code) {
    fprintf(stderr, "BELLTEAM_SEAT_EXEC_%s\n", code);
    return 126;
}

int main(int argc, char **argv) {
    if (geteuid() != 0) return fail("ROOT_REQUIRED");
    if (argc < 3 || argv[1][0] != '-' || argv[1][1] != '-' || argv[1][2] != '\0')
        return fail("ARGUMENTS");

    /* Never inherit the server's environment into the target. Per-bot env.sh
     * and dynamic input must be applied by the later seat-side adapter.
     */
    if (clearenv() != 0) return fail("ENVIRONMENT");
    if (prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0) != 0) return fail("CAPABILITIES");
    if (setgroups(0, NULL) != 0 || setresgid(1000, 1000, 1000) != 0
        || setresuid(1000, 1000, 1000) != 0) return fail("IDENTITY");
    uid_t ru, eu, su;
    gid_t rg, eg, sg;
    if (getresuid(&ru, &eu, &su) != 0 || getresgid(&rg, &eg, &sg) != 0
        || ru != 1000 || eu != 1000 || su != 1000
        || rg != 1000 || eg != 1000 || sg != 1000 || getgroups(0, NULL) != 0)
        return fail("IDENTITY");

    const char *names[] = {"HOME", "USER", "LOGNAME", "SHELL", "PATH", "TERM",
                           "BELLTEAM_HOME", "BELLTEAM_ROOT", "DISABLE_AUTOUPDATER", NULL};
    const char *values[] = {"/home/bell", "bell", "bell", "/bin/bash",
                            "/home/bell/.local/bin:/usr/local/bin:/usr/bin:/bin", "xterm-256color",
                            "/home/bell", "/srv/bellteam", "1"};
    for (size_t i = 0; names[i] != NULL; i++)
        if (setenv(names[i], values[i], 1) != 0) return fail("ENVIRONMENT");
    execvp(argv[2], &argv[2]);
    return fail("EXEC");
}
