package io.github.sunflower2333.dsh

/** Never sweep foreground or unrelated notifications when a new host owns the bridge. */
internal object TaskNotificationOwnership {
    const val ID = 1002
    const val TAG_PREFIX = "dsh-task-"
    fun isOwned(id: Int, tag: String?): Boolean = id == ID && tag?.startsWith(TAG_PREFIX) == true
}
