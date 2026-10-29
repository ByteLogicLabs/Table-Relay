cmake_minimum_required(VERSION 3.22.1)
project(brainexec C)

# The shim local servers run with (see brainexec.c). It is the only native code in the app and needs only libc and libdl.
add_library(brainexec SHARED brainexec.c)
target_compile_options(brainexec PRIVATE -Wall -Wextra -Werror -O2)
target_link_libraries(brainexec dl)
# Phones with 16 KB memory pages (Android 15 on) only load libraries aligned to them, as Termux's builds are.
target_link_options(brainexec PRIVATE "-Wl,-z,max-page-size=16384")
