package io.github.sunflower2333.dsh

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class MobileObservationTreeTest {
    private data class Bounds(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        fun accepted() = MobileObservationTree.acceptsBounds(left, top, right, bottom)
    }
    private data class Node(val id: String, val bounds: Bounds, val children: List<Node?> = emptyList())
    private val visible = Bounds(0, 48, 720, 1280)
    private val clipped = Bounds(144, 1298, 688, 1280)
    private data class Trace(
        val retained: List<Pair<String, List<Int>>>,
        val released: List<String>,
        val lookups: Int,
        val truncated: Boolean
    )

    private fun scan(root: Node, maxVisitedNodes: Int = 1000, maxDepth: Int = 40): Trace {
        val retained = mutableListOf<Pair<String, List<Int>>>()
        val released = mutableListOf<String>()
        var lookups = 0
        val truncated = MobileObservationTree.scan(root, maxVisitedNodes, maxDepth,
            childCount = { it.children.size },
            childAt = { node, index -> lookups++; node.children[index] },
            release = { released.add(it.id) },
            visit = { node, path ->
                node.bounds.accepted().also { if (it) retained.add(node.id to path) }
            })
        return Trace(retained, released, lookups, truncated)
    }

    @Test fun rejectsActualAndroidClippedOffscreenBoundsWithoutInventingGeometry() {
        // Sanitized h28 ARM64 response: nodes 31 and 32, physical display 720x1280.
        assertFalse(clipped.accepted())
        assertFalse(Bounds(0, 1344, 720, 1280).accepted())
        assertFalse(Bounds(720, 48, 0, 1280).accepted())
        assertTrue(visible.accepted())
    }

    @Test fun preservesOrderedOffscreenAndZeroAreaBoundsWithinProtocolLimits() {
        assertTrue(Bounds(-100_000, -100_000, 100_000, 100_000).accepted())
        assertTrue(Bounds(0, 0, 0, 0).accepted())
        assertTrue(Bounds(720, 1280, 720, 1280).accepted())
        assertTrue(Bounds(144, 1298, 688, 1344).accepted())
        // Observation metadata can be empty/offscreen; action visibility guards
        // still reject zero-area targets and out-of-display gesture coordinates.
    }

    @Test fun rejectsEachOutOfRangeCoordinateAndIntegerSentinels() {
        listOf(
            Bounds(-100_001, 0, 10, 10), Bounds(0, -100_001, 10, 10),
            Bounds(0, 0, 100_001, 10), Bounds(0, 0, 10, 100_001),
            Bounds(Int.MIN_VALUE, Int.MIN_VALUE, Int.MAX_VALUE, Int.MAX_VALUE),
            Bounds(Int.MAX_VALUE, Int.MAX_VALUE, Int.MIN_VALUE, Int.MIN_VALUE)
        ).forEach { assertFalse(it.accepted()) }
    }

    @Test fun omittedParentStillRetainsValidDescendantsAndTheirOriginalIndexPaths() {
        val child = Node("child", visible, listOf(Node("grandchild", visible)))
        val root = Node("root", clipped, listOf(null, child))
        val trace = scan(root)
        assertEquals(listOf("child" to listOf(1), "grandchild" to listOf(1, 0)), trace.retained)
        assertEquals(listOf("grandchild", "child"), trace.released)
        assertEquals(3, trace.lookups)
        assertTrue(trace.truncated)
    }

    @Test fun invalidNodesConsumeTheScanBudgetEvenWhenNoTargetsAreRetained() {
        val root = Node("root", clipped, List(2000) { Node("invalid-$it", clipped) })
        val trace = scan(root)
        assertTrue(trace.retained.isEmpty())
        assertEquals(999, trace.lookups)
        assertEquals(999, trace.released.size)
        assertTrue(trace.truncated)
    }

    @Test fun nullChildrenCannotTurnALargeSparseTreeIntoUnboundedLookups() {
        var lookups = 0
        var visits = 0
        var releases = 0
        val truncated = MobileObservationTree.scan("root", 7, 40,
            childCount = { Int.MAX_VALUE },
            childAt = { _, _ -> lookups++; null },
            release = { releases++ },
            visit = { _, _ -> visits++; true })
        assertEquals(6, lookups)
        assertEquals(1, visits)
        assertEquals(0, releases)
        assertTrue(truncated)
    }

    @Test fun depthLimitRetainsTheLastAllowedNodeWithoutAcquiringDeeperChildren() {
        var root = Node("depth-41", visible)
        for (depth in 40 downTo 0) root = Node("depth-$depth", visible, listOf(root))
        val trace = scan(root)
        assertEquals(41, trace.retained.size)
        assertEquals("depth-40" to List(40) { 0 }, trace.retained.last())
        assertEquals(40, trace.lookups)
        assertEquals(40, trace.released.size)
        assertTrue(trace.truncated)
    }

    @Test fun exactBudgetIsCompleteOnlyWhenNoChildSlotsRemain() {
        val complete = scan(Node("root", visible, listOf(Node("leaf", visible))), maxVisitedNodes = 2)
        assertEquals(2, complete.retained.size)
        assertFalse(complete.truncated)
        val omitted = scan(Node("root", visible,
            listOf(Node("leaf", visible), Node("later", visible))), maxVisitedNodes = 2)
        assertEquals(listOf("root" to emptyList<Int>(), "leaf" to listOf(0)), omitted.retained)
        assertEquals(1, omitted.lookups)
        assertTrue(omitted.truncated)
    }

    @Test fun releasesEveryAcquiredChildIfAVisitFailsAndLeavesRootOwnershipToCaller() {
        val root = Node("root", visible, listOf(Node("parent", visible, listOf(Node("leaf", visible)))))
        val released = mutableListOf<String>()
        try {
            MobileObservationTree.scan(root, 1000, 40,
                childCount = { it.children.size }, childAt = { node, index -> node.children[index] },
                release = { released.add(it.id) },
                visit = { node, _ -> if (node.id == "leaf") throw IllegalStateException("test failure") else true })
            fail("Expected the failed observation to propagate")
        } catch (_: IllegalStateException) {
            assertEquals(listOf("leaf", "parent"), released)
        }
    }
}
