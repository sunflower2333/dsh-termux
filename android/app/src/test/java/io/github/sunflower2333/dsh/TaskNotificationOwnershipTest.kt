package io.github.sunflower2333.dsh

import org.junit.Assert.*
import org.junit.Test

class TaskNotificationOwnershipTest {
    @Test fun staleSweepSelectsOnlyOwnTaggedTaskNotifications() {
        assertTrue(TaskNotificationOwnership.isOwned(1002, "dsh-task-abcdef"))
        assertTrue(TaskNotificationOwnership.isOwned(1002, "dsh-task-other-request"))
        assertFalse(TaskNotificationOwnership.isOwned(1001, "dsh-task-abcdef"))
        assertFalse(TaskNotificationOwnership.isOwned(1002, "other-task-abcdef"))
        assertFalse(TaskNotificationOwnership.isOwned(1002, "dsh-task"))
        assertFalse(TaskNotificationOwnership.isOwned(1002, null))
        assertFalse(TaskNotificationOwnership.isOwned(1003, "dsh-task-abcdef"))
    }
}
