package io.github.sunflower2333.dsh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class WorkspaceSelectionPolicyTest {
    private val request = "workspace_fixture_0123456789"
    private val ready = "http://127.0.0.1:4312/?token=fixture-only"
    private val page = "http://127.0.0.1:4312/session#chat"
    private val action = "http://127.0.0.1:4312${WebNavigation.WORKSPACE_STORAGE_PATH}?request=$request"

    @Test fun requestAcceptsOnlyExactOriginAndOneBoundedOpaqueParameter() {
        assertEquals(request, WebNavigation.workspaceRequestId(action, page, ready))
        for (candidate in listOf(action + "&path=/storage", action + "&request=$request", action + "#other",
            action.replace("request=", "path="), action.replace(request, "too-short"),
            action.replace(request, "a".repeat(81)), action.replace(request, "%61".repeat(20)),
            action.replace("4312", "4313"), action.replace("127.0.0.1", "localhost"),
            action.replace("choose-workspace", "%63hoose-workspace"), action.replace("?request", "/?request"))) {
            assertNull(candidate, WebNavigation.workspaceRequestId(candidate, page, ready))
        }
        assertNull(WebNavigation.workspaceRequestId(action, "https://example.test/", ready))
        assertNull(WebNavigation.workspaceRequestId(action, null, ready))
        assertNull(WebNavigation.workspaceRequestId(action, page, null))
    }

    @Test fun mapsPrimaryAndMountedUuidWithNoGuessedStoragePaths() {
        val primary = File("/fixture/primary")
        val sd = File("/fixture/removable")
        val volumes = listOf(WorkspaceSelectionPolicy.Volume("primary", primary), WorkspaceSelectionPolicy.Volume("ABCD-1234", sd))
        assertEquals(File(primary, "Documents/Project name"), selection("primary:Documents/Project name", volumes)?.directory)
        assertEquals(File(sd, "Projects/移动项目"), selection("abcd-1234:Projects/移动项目", volumes)?.directory)
        assertNull(selection("missing:Projects", volumes))
        assertNull(selection("ABCD-1234:Projects", volumes + WorkspaceSelectionPolicy.Volume("abcd-1234", File("/other"))))
    }

    @Test fun refusesRootsProtectedAndroidFoldersAndTraversalBeforeFilesystemAccess() {
        val volumes = listOf(WorkspaceSelectionPolicy.Volume("primary", File("/fixture")))
        for (id in listOf("primary:", "primary", "primary:/Documents", "primary:Documents/", "primary:Documents//Project",
            "primary:../outside", "primary:Documents/../../outside", "primary:./Documents", "primary:Documents/../Project",
            "primary:Documents\\Project", "primary:Documents/\u0000bad", "primary:Android/data/app", "primary:android/OBB/game",
            "../../volume:Project", "primary:Android/data", "primary:Android/obb")) {
            assertNull(id, selection(id, volumes))
        }
        assertNotNull(selection("primary:Android/media/project", volumes))
        assertNotNull(selection("primary:Documents/Android/data", volumes))
        assertNull(WorkspaceSelectionPolicy.selection("com.android.providers.downloads.documents", "primary:Documents", volumes))
        assertNull(WorkspaceSelectionPolicy.selection("cloud.example", "primary:Documents", volumes))
        assertNull(WorkspaceSelectionPolicy.selection(null, "primary:Documents", volumes))
    }

    @Test fun canonicalFenceAcceptsRealDirectoryAndVolumeAliasButRejectsAnyFolderLink() {
        val root = Files.createTempDirectory("dsh-workspace-policy").toFile()
        try {
            val volume = File(root, "volume").apply { mkdir() }
            val project = File(volume, "Project").apply { mkdir() }
            val outside = File(root, "outside").apply { mkdir() }
            val volumes = listOf(WorkspaceSelectionPolicy.Volume("primary", volume))
            assertEquals(project.canonicalFile, WorkspaceSelectionPolicy.canonicalDirectory(selection("primary:Project", volumes)!!))
            Files.createSymbolicLink(File(volume, "Escape").toPath(), outside.toPath())
            Files.createSymbolicLink(File(volume, "Alias").toPath(), project.toPath())
            for (id in listOf("primary:Escape", "primary:Alias", "primary:Missing"))
                assertNull(id, WorkspaceSelectionPolicy.canonicalDirectory(selection(id, volumes)!!))
            File(volume, "file").writeText("preserved")
            assertNull(WorkspaceSelectionPolicy.canonicalDirectory(selection("primary:file", volumes)!!))
            val alias = File(root, "volume-alias")
            Files.createSymbolicLink(alias.toPath(), volume.toPath())
            val aliasSelection = selection("primary:Project", listOf(WorkspaceSelectionPolicy.Volume("primary", alias)))!!
            assertEquals(project.canonicalFile, WorkspaceSelectionPolicy.canonicalDirectory(aliasSelection))
            assertEquals("preserved", File(volume, "file").readText())
        } finally { root.deleteRecursively() }
    }

    @Test fun nativeResultRequiresOriginalReadyRuntimeAndMountedAuthenticatedPage() {
        assertTrue(WorkspaceSelectionPolicy.canDeliver(request, ready, ready, page, true))
        assertFalse(WorkspaceSelectionPolicy.canDeliver(request, ready, ready, page, false))
        assertFalse(WorkspaceSelectionPolicy.canDeliver("short", ready, ready, page, true))
        assertFalse(WorkspaceSelectionPolicy.canDeliver(request, ready, ready.replace("fixture-only", "new-runtime"), page, true))
        assertFalse(WorkspaceSelectionPolicy.canDeliver(request, ready, ready, page.replace("4312", "4313"), true))
        assertFalse(WorkspaceSelectionPolicy.canDeliver(request, ready, ready, "https://example.test/", true))
        assertFalse(WorkspaceSelectionPolicy.canDeliver(request, null, ready, page, true))
        assertFalse(WorkspaceSelectionPolicy.canDeliver(request, ready, ready, null, true))
    }

    private fun selection(id: String, volumes: List<WorkspaceSelectionPolicy.Volume>) =
        WorkspaceSelectionPolicy.selection(WorkspaceSelectionPolicy.EXTERNAL_STORAGE_PROVIDER, id, volumes)
}
