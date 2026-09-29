/* Qualification-only timestamp immediately before exec; never reads the product binary. */
#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE 1
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 4 || argv[1][0] != '/' || argv[3][0] != '/' || strlen(argv[2]) != 36)
    return 125;
  for (int i = 0; i < 36; i++)
    if (!((argv[2][i] >= '0' && argv[2][i] <= '9') ||
          (argv[2][i] >= 'a' && argv[2][i] <= 'f') || argv[2][i] == '-')) return 125;
  struct timespec wall, mono;
  if (clock_gettime(CLOCK_REALTIME, &wall) || clock_gettime(CLOCK_MONOTONIC, &mono)) return 125;
  int fd = open(argv[1], O_WRONLY | O_APPEND | O_NOFOLLOW | O_NONBLOCK);
  struct stat st;
  if (fd < 0) return 125;
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != getuid() ||
      (st.st_mode & 0777) != 0600 || st.st_nlink != 1 || st.st_size > 16384) {
    close(fd); return 125;
  }
  char line[512];
  int length = snprintf(line, sizeof(line),
    "{\"version\":1,\"launchId\":\"%s\",\"phase\":\"pre-exec\",\"pid\":%ld,"
    "\"atMs\":%.3f,\"monotonicNs\":\"%lld\",\"clock\":\"clock-monotonic\"}\n",
    argv[2], (long)getpid(), wall.tv_sec * 1000.0 + wall.tv_nsec / 1000000.0,
    (long long)mono.tv_sec * 1000000000LL + mono.tv_nsec);
  if (length <= 0 || length >= (int)sizeof(line) || st.st_size + length > 16384 ||
      write(fd, line, length) != length) {
    close(fd); return 125;
  }
  if (close(fd)) return 125;
  execv(argv[3], argv + 3);
  return 126;
}
