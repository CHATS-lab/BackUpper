/* rb-boot -- setuid-root launcher for start.sh.
 *
 * The image's USER is `agent`, an unprivileged account, so that a shell
 * obtained with `docker exec` (which takes the image's user when no -u is
 * given) cannot read the cluster's data directories, the admin kubeconfig or
 * the containerd socket.  But the container's entrypoint runs as that same
 * user, and k3s needs root.  This binary is the bridge: it is installed
 * 4755 root:root and does nothing except re-exec start.sh as root.
 *
 * It is not a privilege escalation for the agent:
 *   - start.sh refuses to run twice (it takes an exclusive boot marker), so
 *     the agent cannot re-enter it once the container has booted;
 *   - the environment is rebuilt from scratch here, keeping only PATH, HOME
 *     and the K8SENV_* knobs, so nothing the agent sets can steer the boot;
 *   - start.sh's final exec drops back to the agent uid, so even a
 *     hypothetical re-entry would not hand out a root shell.
 */
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAXENV 64

int main(int argc, char **argv, char **envp) {
    if (setgid(0) != 0 || setuid(0) != 0)
        return 111;

    char *newenv[MAXENV];
    int n = 0;
    newenv[n++] = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    newenv[n++] = "HOME=/root";
    newenv[n++] = "KUBECONFIG=/etc/rancher/k3s/k3s.yaml";
    for (char **e = envp; *e && n < MAXENV - 1; e++)
        if (strncmp(*e, "K8SENV_", 7) == 0)
            newenv[n++] = *e;
    newenv[n] = NULL;

    char *newargv[MAXENV];
    newargv[0] = "/usr/local/bin/start.sh";
    int m = 1;
    for (int i = 1; i < argc && m < MAXENV - 1; i++)
        newargv[m++] = argv[i];
    newargv[m] = NULL;

    execve("/usr/local/bin/start.sh", newargv, newenv);
    return 112;
}
