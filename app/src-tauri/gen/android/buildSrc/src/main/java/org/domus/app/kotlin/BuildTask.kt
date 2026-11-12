import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction
import javax.inject.Inject
import org.gradle.process.ExecOperations

abstract class BuildTask : DefaultTask() {
    @get:Inject
    abstract val execOperations: ExecOperations

    @Input
    var rootDirRel: String? = null
    @Input
    var projectDir: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null
    /** -PdomusPrebuilt=true: only copy the libraries `tauri android build` already built. */
    @Input
    var prebuilt: Boolean = false

    @TaskAction
    fun assemble() {
        // Error output of the Tauri CLI, to recognise the symlink failure.
        val errors = java.io.ByteArrayOutputStream()
        if (prebuilt) {
            if (!copyLibrary()) throw GradleException("prebuilt library for $target is missing – build it with `npx tauri android build --target $target` first")
            logger.lifecycle("Domus: using the prebuilt native library for $target")
            return
        }
        try {
            runAll(errors)
        } catch (e: Exception) {
            // Windows without developer mode cannot create the symbolic link
            // the Tauri CLI puts into jniLibs. The library itself is built by
            // then (the link is the last step), so it is copied instead.
            val symlinkOnly = errors.toString().contains("symbolic link")
            if (!Os.isFamily(Os.FAMILY_WINDOWS) || !symlinkOnly || !copyLibrary()) throw e
            logger.lifecycle("Domus: copied the native library into jniLibs (no symlink permission)")
        }
    }

    private fun copyLibrary(): Boolean {
        val (triple, abi) = when (target) {
            "aarch64" -> "aarch64-linux-android" to "arm64-v8a"
            "armv7" -> "armv7-linux-androideabi" to "armeabi-v7a"
            "i686" -> "i686-linux-android" to "x86"
            "x86_64" -> "x86_64-linux-android" to "x86_64"
            else -> return false
        }
        val profile = if (release == true) "release" else "debug"
        val lib = File(File(projectDir, rootDirRel!!), "../../target/$triple/$profile/libnexustalk_lib.so").canonicalFile
        if (!lib.exists()) return false
        val dest = File(projectDir, "src/main/jniLibs/$abi/libnexustalk_lib.so")
        dest.parentFile.mkdirs()
        dest.delete()
        lib.copyTo(dest, overwrite = true)
        return true
    }

    private fun runAll(errors: java.io.ByteArrayOutputStream) {
        val executable = """npm""";
        try {
            runTauriCli(executable, errors)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )

                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback, errors)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    fun runTauriCli(executable: String, errors: java.io.ByteArrayOutputStream) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = listOf("run", "--", "tauri", "android", "android-studio-script");

        execOperations.exec {
            errorOutput = object : java.io.OutputStream() {
                override fun write(b: Int) {
                    System.err.write(b)
                    errors.write(b)
                }
                override fun write(b: ByteArray, off: Int, len: Int) {
                    System.err.write(b, off, len)
                    errors.write(b, off, len)
                }
            }
            workingDir(File(projectDir, rootDirRel))
            executable(executable)
            args(args)
            if (logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}