package io.github.sunflower2333.dsh

/** Bounded traversal shared by the Android observer and its host-side regression tests. */
internal object MobileObservationTree {
    private const val BOUND_LIMIT = 100_000

    fun acceptsBounds(left: Int, top: Int, right: Int, bottom: Int): Boolean =
        left in -BOUND_LIMIT..BOUND_LIMIT && top in -BOUND_LIMIT..BOUND_LIMIT &&
            right in -BOUND_LIMIT..BOUND_LIMIT && bottom in -BOUND_LIMIT..BOUND_LIMIT &&
            right >= left && bottom >= top

    /**
     * The caller owns root; this traversal releases every child it acquires.
     * Returning false from visit omits only that node, never its descendants.
     * Every child lookup, including a null result, consumes the scan budget.
     */
    fun <T : Any> scan(
        root: T,
        maxVisitedNodes: Int,
        maxDepth: Int,
        childCount: (T) -> Int,
        childAt: (T, Int) -> T?,
        release: (T) -> Unit,
        visit: (T, List<Int>) -> Boolean
    ): Boolean {
        require(maxVisitedNodes > 0 && maxDepth >= 0)
        var visited = 1
        var truncated = false
        fun walk(node: T, path: List<Int>, depth: Int) {
            if (!visit(node, path)) truncated = true
            val count = childCount(node)
            if (count > 0 && depth >= maxDepth) {
                truncated = true
                return
            }
            for (index in 0 until count) {
                if (visited >= maxVisitedNodes) {
                    truncated = true
                    break
                }
                visited++
                val child = childAt(node, index) ?: continue
                try { walk(child, path + index, depth + 1) } finally { release(child) }
            }
        }
        walk(root, emptyList(), 0)
        return truncated
    }
}
