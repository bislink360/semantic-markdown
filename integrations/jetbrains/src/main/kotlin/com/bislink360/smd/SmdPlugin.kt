package com.bislink360.smd

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.util.EnvironmentUtil
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.exists

object SmdPlugin {
    const val ID = "com.bislink360.styled-markdown"
    const val NOTIFICATIONS = "Semantic Markdown"

    /**
     * The plugin's folder: its jar in lib/, the server in server/, the TextMate bundle in bundle/. Found from the jar
     * this class is in, since the plugin manager's lookup by ID is internal API (and its PluginId changed in 2025.3).
     */
    val directory: Path
        get() = PathManager.getJarPathForClass(SmdPlugin::class.java)?.let { Path.of(it).parent?.parent }
            ?: error("The Semantic Markdown plugin's folder was not found")

    /** The TextMate bundle made from the VS Code extension's grammar (see build.gradle.kts). */
    val bundle: Path get() = directory.resolve("bundle")

    /** The `smd` CLI shipped with the plugin: one self-contained file, the same as the agent skills bundle. */
    val bundledCli: Path get() = directory.resolve("server").resolve("smd.cjs")

    /** The CLI to run: the one set in Settings | Languages & Frameworks | Semantic Markdown, else the bundled one. */
    fun cli(): Path = SmdSettings.getInstance().cliPath.takeIf { it.isNotBlank() }?.let(Path::of) ?: bundledCli

    /** The Node.js executable: the one set in the settings, else `node` on the PATH (null when there is none). */
    fun node(): String? {
        val configured = SmdSettings.getInstance().nodePath.trim()
        if (configured.isNotEmpty()) return configured
        return findOnPath("node")?.toString()
    }

    private val isWindows = System.getProperty("os.name").orEmpty().startsWith("Windows")

    /**
     * [name] on the PATH the IDE gives to processes it starts (on macOS, the login shell's), with Windows' executable
     * extensions. The platform's own lookups (PathEnvironmentVariableUtil) are deprecated since 2026.x.
     */
    fun findOnPath(name: String): Path? {
        val path = EnvironmentUtil.getValue("PATH") ?: System.getenv("PATH") ?: return null
        val names = if (isWindows) {
            val extensions = (System.getenv("PATHEXT") ?: ".COM;.EXE;.BAT;.CMD").split(';').filter { it.isNotBlank() }
            extensions.map { name + it.lowercase() }
        } else {
            listOf(name)
        }
        for (folder in path.split(File.pathSeparatorChar).filter { it.isNotBlank() }) {
            for (candidate in names) {
                val file = runCatching { Path.of(folder.trim('"'), candidate) }.getOrNull() ?: continue
                if (Files.isRegularFile(file) && (isWindows || Files.isExecutable(file))) return file
            }
        }
        return null
    }

    /** `node <cli> <args>`, run in [workDirectory]; null when Node.js or the CLI can't be found. */
    fun command(workDirectory: Path?, vararg args: String): GeneralCommandLine? {
        val node = node() ?: return null
        val cli = cli()
        if (!cli.exists()) return null
        return GeneralCommandLine(node, cli.toString(), *args)
            .withCharset(Charsets.UTF_8)
            .withWorkingDirectory(workDirectory)
            .withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
    }
}

fun VirtualFile.isSmd(): Boolean = !isDirectory && extension == "smd"
