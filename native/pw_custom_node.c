/*
 * PipeWire Custom ALSA Node Helper
 * =================================
 * Creates custom PipeWire ALSA capture+playback nodes for a device WITHOUT the
 * auto-link/node-group properties that cause audio corruption on multi-channel
 * USB devices (e.g. Neural DSP Nano Cortex in pro-audio profile).
 *
 * This process must stay alive — nodes are destroyed when the process exits.
 * The parent (tuidaw native engine) spawns this, waits for "READY" on stdout,
 * then proceeds with JACK monitoring. On monitoring stop, the parent sends
 * SIGTERM to clean up.
 *
 * Build: cc -o native/pw_custom_node native/pw_custom_node.c \
 *          $(pkg-config --cflags --libs libpipewire-0.3) -lm
 *
 * Usage: pw_custom_node --device hw:5 --card alsa_card.usb-... [--channels 8] [--track-id 1]
 *
 * The playback node (with node.always-process + node.driver) is required for
 * USB devices using Implicit Feedback Mode (capture clock derived from playback).
 *
 * On exit (SIGTERM, SIGHUP, or parent death), the helper restores the card
 * profile to pro-audio so the device remains usable.
 */
#include <pipewire/pipewire.h>
#include <spa/param/audio/format-utils.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <sys/prctl.h>  // PR_SET_PDEATHSIG
#include <sys/wait.h>   // waitpid

static struct pw_main_loop *loop = NULL;
static char g_card_name[256] = {0};  // for profile restoration on exit

static void restore_profile(void) {
    if (!g_card_name[0]) return;
    /* Use fork+exec (async-signal-safe-ish) to restore profile.
     * We avoid system() which may have issues in signal context. */
    pid_t pid = fork();
    if (pid == 0) {
        char cmd[512];
        snprintf(cmd, sizeof(cmd), "pactl set-card-profile %s pro-audio", g_card_name);
        execl("/bin/sh", "sh", "-c", cmd, (char*)NULL);
        _exit(127);
    } else if (pid > 0) {
        int status;
        waitpid(pid, &status, 0);
    }
    g_card_name[0] = '\0';  // only restore once
}

static void signal_handler(int sig) {
    if (loop) pw_main_loop_quit(loop);
}

int main(int argc, char *argv[]) {
    const char *device = "hw:5";
    int channels = 8;
    int track_id = 0;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--device") == 0 && i + 1 < argc)
            device = argv[++i];
        else if (strcmp(argv[i], "--channels") == 0 && i + 1 < argc)
            channels = atoi(argv[++i]);
        else if (strcmp(argv[i], "--track-id") == 0 && i + 1 < argc)
            track_id = atoi(argv[++i]);
        else if (strcmp(argv[i], "--card") == 0 && i + 1 < argc) {
            strncpy(g_card_name, argv[++i], sizeof(g_card_name) - 1);
        }
    }

    /* Request SIGHUP when parent process dies (Linux-specific).
     * This ensures we clean up even if the parent crashes without sending
     * SIGTERM. Also register atexit for normal exit paths. */
    prctl(PR_SET_PDEATHSIG, SIGHUP);
    /* Check if parent already died between fork() and prctl() */
    if (getppid() == 1) {
        restore_profile();
        return 1;
    }
    atexit(restore_profile);

    pw_init(&argc, &argv);

    loop = pw_main_loop_new(NULL);
    if (!loop) {
        fprintf(stderr, "ERROR: Failed to create PipeWire main loop\n");
        return 1;
    }

    struct pw_context *context = pw_context_new(
        pw_main_loop_get_loop(loop), NULL, 0);
    if (!context) {
        fprintf(stderr, "ERROR: Failed to create PipeWire context\n");
        return 1;
    }

    struct pw_core *core = pw_context_connect(context, NULL, 0);
    if (!core) {
        fprintf(stderr, "ERROR: Failed to connect to PipeWire\n");
        return 1;
    }

    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    signal(SIGHUP, signal_handler);

    /* Unique node names per track */
    char play_name[64], cap_name[64];
    snprintf(play_name, sizeof(play_name), "tuidaw-custom-play-%d", track_id);
    snprintf(cap_name, sizeof(cap_name), "tuidaw-custom-cap-%d", track_id);

    char ch_str[8];
    snprintf(ch_str, sizeof(ch_str), "%d", channels);

    /* Build audio.position string for the channel count */
    char position[256] = {0};
    if (channels <= 8) {
        /* Use AUX0..AUX7 naming for pro-audio compatibility */
        strcpy(position, "[ ");
        for (int i = 0; i < channels; i++) {
            char aux[16];
            snprintf(aux, sizeof(aux), "AUX%d%s", i, i < channels - 1 ? " " : "");
            strcat(position, aux);
        }
        strcat(position, " ]");
    }

    /* Create playback node (for Implicit Feedback Mode clock) */
    struct pw_properties *play_props = pw_properties_new(
        "factory.name", "api.alsa.pcm.sink",
        "node.name", play_name,
        "media.class", "Audio/Sink",
        "api.alsa.path", device,
        "audio.channels", ch_str,
        "audio.rate", "48000",
        "node.pause-on-idle", "false",
        "node.always-process", "true",
        "session.suspend-timeout-seconds", "0",
        "node.driver", "true",
        "node.latency", "256/48000",
        "api.alsa.period-size", "256",
        "api.alsa.period-num", "3",
        "api.alsa.disable-tsched", "true",
        NULL);

    struct pw_proxy *play_proxy = (struct pw_proxy *)pw_core_create_object(core,
        "adapter", PW_TYPE_INTERFACE_Node,
        PW_VERSION_NODE, &play_props->dict, 0);

    if (!play_proxy) {
        fprintf(stderr, "ERROR: Failed to create playback node\n");
        return 1;
    }

    /* Create capture node */
    struct pw_properties *cap_props = pw_properties_new(
        "factory.name", "api.alsa.pcm.source",
        "node.name", cap_name,
        "media.class", "Audio/Source",
        "api.alsa.path", device,
        "audio.channels", ch_str,
        "audio.rate", "48000",
        "node.pause-on-idle", "false",
        "session.suspend-timeout-seconds", "0",
        "node.latency", "256/48000",
        "api.alsa.period-size", "256",
        "api.alsa.period-num", "3",
        "api.alsa.disable-tsched", "true",
        NULL);

    if (position[0])
        pw_properties_set(cap_props, "audio.position", position);

    struct pw_proxy *cap_proxy = (struct pw_proxy *)pw_core_create_object(core,
        "adapter", PW_TYPE_INTERFACE_Node,
        PW_VERSION_NODE, &cap_props->dict, 0);

    if (!cap_proxy) {
        fprintf(stderr, "ERROR: Failed to create capture node\n");
        pw_proxy_destroy(play_proxy);
        return 1;
    }

    /* Signal readiness to parent process */
    printf("READY\n");
    fflush(stdout);

    /* Run until SIGTERM/SIGINT */
    pw_main_loop_run(loop);

    /* Cleanup */
    pw_proxy_destroy(cap_proxy);
    pw_proxy_destroy(play_proxy);
    pw_core_disconnect(core);
    pw_context_destroy(context);
    pw_main_loop_destroy(loop);
    pw_deinit();

    return 0;
}
