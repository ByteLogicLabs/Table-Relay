/*
 * Brain DB's shim, loaded with LD_PRELOAD into the server programs Brain DB runs and the shells they start. It stands
 * in for two things an app's processes can't do on Android:
 *
 * - exec. Android doesn't let an app execve() a file it wrote itself (W^X, for apps targeting SDK 29 and up), but the
 *   system linker may still load one, so Brain DB starts a server as "/system/bin/linker64 <program> <args>". Some
 *   programs start others in turn (initdb runs postgres through /system/bin/sh): their execve() of an ELF file under
 *   one of the directories in BRAINDB_EXEC_ROOT (colon-separated canonical paths) becomes that same linker call. Any
 *   other execve() passes through unchanged.
 *
 * - System V shared memory. SELinux denies apps shmget(), and Termux's libandroid-shmem, which its PostgreSQL build
 *   calls instead (as libandroid_shm*), keeps its keys in Termux's own tmp directory. PostgreSQL only needs a segment
 *   the postmaster makes and the backends it forks inherit, so a segment here is a shared anonymous mapping, known by
 *   its id in the process that made it and the processes forked from it.
 *
 * It also lets regcomp() take the GNU escapes \s \S \w \W, which programs written against glibc use and bionic's
 * regex rejects (Valkey's clock setup on x86_64 asserts on it).
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <regex.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/shm.h>
#include <unistd.h>

#if defined(__LP64__)
#define LINKER "/system/bin/linker64"
#else
#define LINKER "/system/bin/linker"
#endif

typedef int (*execve_fn)(const char *, char *const[], char *const[]);

static execve_fn real_execve;
static char roots[4096];

/* Read once at load time, so execve() itself (which may run in a vfork child) only makes system calls. */
__attribute__((constructor)) static void brainexec_init(void) {
    real_execve = (execve_fn) dlsym(RTLD_NEXT, "execve");
    const char *value = getenv("BRAINDB_EXEC_ROOT");
    if (value != NULL && strlen(value) < sizeof(roots)) strcpy(roots, value);
}

static int under_root(const char *path) {
    const char *root = roots;
    while (*root != '\0') {
        const char *end = strchr(root, ':');
        size_t n = end != NULL ? (size_t) (end - root) : strlen(root);
        if (n > 0 && strncmp(path, root, n) == 0 && path[n] == '/') return 1;
        if (end == NULL) break;
        root = end + 1;
    }
    return 0;
}

static int is_elf(const char *path) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return 0;
    unsigned char magic[4];
    ssize_t n = read(fd, magic, sizeof(magic));
    close(fd);
    return n == 4 && magic[0] == 0x7f && magic[1] == 'E' && magic[2] == 'L' && magic[3] == 'F';
}

int execve(const char *path, char *const argv[], char *const envp[]) {
    if (real_execve == NULL) real_execve = (execve_fn) dlsym(RTLD_NEXT, "execve");
    char resolved[PATH_MAX];
    if (path != NULL && roots[0] != '\0' && realpath(path, resolved) != NULL && under_root(resolved) && is_elf(resolved)) {
        int argc = 0;
        while (argv != NULL && argv[argc] != NULL) argc++;
        /* linker64 <program> <argv[1]>…: the program then sees its own path as argv[0]. */
        const char *args[argc + 3];
        int n = 0;
        args[n++] = LINKER;
        args[n++] = resolved;
        for (int i = 1; i < argc; i++) args[n++] = argv[i];
        args[n] = NULL;
        return real_execve(LINKER, (char *const *) args, envp);
    }
    return real_execve(path, argv, envp);
}

#define MAX_SEGMENTS 64

struct segment {
    int id; /* 0: a free slot */
    key_t key;
    size_t size;
    void *addr;
    int attached;
    int removed;
};

static struct segment segments[MAX_SEGMENTS];
static int next_id = 1;
static pthread_mutex_t segments_lock = PTHREAD_MUTEX_INITIALIZER;

static struct segment *segment_by_id(int id) {
    for (int i = 0; i < MAX_SEGMENTS; i++) {
        if (segments[i].id == id && id != 0) return &segments[i];
    }
    return NULL;
}

static void segment_free(struct segment *s) {
    munmap(s->addr, s->size);
    memset(s, 0, sizeof(*s));
}

int shmget(key_t key, size_t size, int flags) {
    int result = -1;
    pthread_mutex_lock(&segments_lock);
    struct segment *slot = NULL;
    for (int i = 0; i < MAX_SEGMENTS; i++) {
        struct segment *s = &segments[i];
        if (s->id == 0) {
            if (slot == NULL) slot = s;
        } else if (key != IPC_PRIVATE && s->key == key && !s->removed) {
            if ((flags & IPC_CREAT) && (flags & IPC_EXCL)) errno = EEXIST;
            else if (size > s->size) errno = EINVAL;
            else result = s->id;
            goto done;
        }
    }
    if (key != IPC_PRIVATE && !(flags & IPC_CREAT)) {
        errno = ENOENT;
    } else if (size == 0) {
        errno = EINVAL;
    } else if (slot == NULL) {
        errno = ENOSPC;
    } else {
        void *addr = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
        if (addr == MAP_FAILED) {
            errno = ENOMEM;
        } else {
            slot->id = next_id++;
            slot->key = key;
            slot->size = size;
            slot->addr = addr;
            result = slot->id;
        }
    }
done:
    pthread_mutex_unlock(&segments_lock);
    return result;
}

void *shmat(int id, const void *addr, int flags) {
    (void) flags;
    void *result = (void *) -1;
    pthread_mutex_lock(&segments_lock);
    struct segment *s = segment_by_id(id);
    if (s == NULL || (addr != NULL && addr != s->addr)) {
        errno = EINVAL;
    } else {
        s->attached++;
        result = s->addr;
    }
    pthread_mutex_unlock(&segments_lock);
    return result;
}

/* The mapping stays until the segment is removed as well: nothing here can map its memory again once it's gone. */
int shmdt(const void *addr) {
    int result = -1;
    pthread_mutex_lock(&segments_lock);
    for (int i = 0; i < MAX_SEGMENTS; i++) {
        struct segment *s = &segments[i];
        if (s->id != 0 && s->addr == addr && s->attached > 0) {
            s->attached--;
            if (s->attached == 0 && s->removed) segment_free(s);
            result = 0;
            break;
        }
    }
    if (result != 0) errno = EINVAL;
    pthread_mutex_unlock(&segments_lock);
    return result;
}

int shmctl(int id, int cmd, struct shmid_ds *buf) {
    int result = -1;
    pthread_mutex_lock(&segments_lock);
    struct segment *s = segment_by_id(id);
    if (s == NULL) {
        errno = EINVAL;
    } else if (cmd == IPC_STAT) {
        if (buf == NULL) {
            errno = EFAULT;
        } else {
            memset(buf, 0, sizeof(*buf));
            buf->shm_perm.key = s->key;
            buf->shm_perm.uid = buf->shm_perm.cuid = geteuid();
            buf->shm_perm.gid = buf->shm_perm.cgid = getegid();
            buf->shm_perm.mode = 0600;
            buf->shm_segsz = s->size;
            buf->shm_nattch = s->attached;
            buf->shm_cpid = buf->shm_lpid = getpid();
            result = 0;
        }
    } else if (cmd == IPC_RMID) {
        s->removed = 1;
        if (s->attached == 0) segment_free(s);
        result = 0;
    } else if (cmd == IPC_SET) {
        result = 0;
    } else {
        errno = EINVAL;
    }
    pthread_mutex_unlock(&segments_lock);
    return result;
}

/* The names Termux's builds call (its sys/shm.h renames them to libandroid-shmem's). */
int libandroid_shmget(key_t key, size_t size, int flags) __attribute__((alias("shmget")));
void *libandroid_shmat(int id, const void *addr, int flags) __attribute__((alias("shmat")));
int libandroid_shmdt(const void *addr) __attribute__((alias("shmdt")));
int libandroid_shmctl(int id, int cmd, struct shmid_ds *buf) __attribute__((alias("shmctl")));

typedef int (*regcomp_fn)(regex_t *, const char *, int);

/* [pattern] with \s \S \w \W outside bracket expressions spelled as POSIX classes; NULL if it has none or is too long. */
static const char *posix_classes(const char *pattern, char *out, size_t size) {
    size_t n = 0;
    int changed = 0;
    for (const char *p = pattern; *p != '\0'; p++) {
        if (n + 16 >= size) return NULL;
        if (*p == '\\' && p[1] != '\0') {
            const char *spelled = NULL;
            switch (p[1]) {
                case 's': spelled = "[[:space:]]"; break;
                case 'S': spelled = "[^[:space:]]"; break;
                case 'w': spelled = "[[:alnum:]_]"; break;
                case 'W': spelled = "[^[:alnum:]_]"; break;
            }
            if (spelled != NULL) {
                size_t len = strlen(spelled);
                memcpy(out + n, spelled, len);
                n += len;
                changed = 1;
            } else {
                out[n++] = p[0];
                out[n++] = p[1];
            }
            p++;
        } else if (*p == '[') {
            /* A bracket expression is copied as it is: a backslash in it is literal, and ']' first is a member. */
            const char *q = p + 1;
            if (*q == '^') q++;
            if (*q == ']') q++;
            while (*q != '\0' && *q != ']') {
                if (q[0] == '[' && (q[1] == ':' || q[1] == '.' || q[1] == '=')) {
                    const char *end = strstr(q + 2, q[1] == ':' ? ":]" : q[1] == '.' ? ".]" : "=]");
                    if (end == NULL) return NULL;
                    q = end + 2;
                } else {
                    q++;
                }
            }
            if (*q == '\0') return NULL;
            size_t len = (size_t) (q - p) + 1;
            if (n + len + 16 >= size) return NULL;
            memcpy(out + n, p, len);
            n += len;
            p = q;
        } else {
            out[n++] = *p;
        }
    }
    out[n] = '\0';
    return changed ? out : NULL;
}

int regcomp(regex_t *preg, const char *pattern, int cflags) {
    static regcomp_fn real_regcomp;
    if (real_regcomp == NULL) real_regcomp = (regcomp_fn) dlsym(RTLD_NEXT, "regcomp");
    char rewritten[1024];
    const char *posix = pattern != NULL ? posix_classes(pattern, rewritten, sizeof(rewritten)) : NULL;
    return real_regcomp(preg, posix != NULL ? posix : pattern, cflags);
}
