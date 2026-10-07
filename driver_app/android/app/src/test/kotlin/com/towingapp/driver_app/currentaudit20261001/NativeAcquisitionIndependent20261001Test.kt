package com.towingapp.driver_app.currentaudit20261001

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import com.towingapp.driver_app.DutyForegroundService
import com.towingapp.driver_app.NativeOwnershipCoordinator
import com.towingapp.driver_app.SessionToken
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Fresh independent audit probes. They invoke the CURRENT native production classes. */
class NativeAcquisitionIndependent20261001Test {
    private class AuditPreferences : SharedPreferences {
        private val values = mutableMapOf<String, Any?>()
        @Synchronized override fun getAll(): MutableMap<String, *> = values.toMutableMap()
        @Synchronized override fun getString(key: String?, defValue: String?): String? = values[key] as? String ?: defValue
        @Synchronized override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? = (values[key] as? Set<String>)?.toMutableSet() ?: defValues
        @Synchronized override fun getInt(key: String?, defValue: Int): Int = values[key] as? Int ?: defValue
        @Synchronized override fun getLong(key: String?, defValue: Long): Long = values[key] as? Long ?: defValue
        @Synchronized override fun getFloat(key: String?, defValue: Float): Float = values[key] as? Float ?: defValue
        @Synchronized override fun getBoolean(key: String?, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
        @Synchronized override fun contains(key: String?): Boolean = values.containsKey(key)
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        override fun edit(): SharedPreferences.Editor = AuditEditor()
        private inner class AuditEditor : SharedPreferences.Editor {
            private val update = mutableMapOf<String, Any?>()
            private var wipe = false
            override fun putString(key: String?, value: String?) = apply { update[key!!] = value }
            override fun putStringSet(key: String?, values: MutableSet<String>?) = apply { update[key!!] = values?.toSet() }
            override fun putInt(key: String?, value: Int) = apply { update[key!!] = value }
            override fun putLong(key: String?, value: Long) = apply { update[key!!] = value }
            override fun putFloat(key: String?, value: Float) = apply { update[key!!] = value }
            override fun putBoolean(key: String?, value: Boolean) = apply { update[key!!] = value }
            override fun remove(key: String?) = apply { update[key!!] = null }
            override fun clear() = apply { wipe = true }
            override fun commit(): Boolean {
                synchronized(this@AuditPreferences) {
                    if (wipe) values.clear()
                    for ((key, value) in update) if (value == null) values.remove(key) else values[key] = value
                }
                return true
            }
            override fun apply() { commit() }
        }
    }
    private class AuditContext(val preferences: AuditPreferences) : ContextWrapper(null) {
        override fun getApplicationContext(): Context = this
        override fun getSharedPreferences(name: String?, mode: Int): SharedPreferences = preferences
    }
    private class Reply : MethodChannel.Result {
        val completed = CountDownLatch(1)
        var value: Any? = null
        var errorCode: String? = null
        override fun success(result: Any?) { value = result; completed.countDown() }
        override fun error(errorCode: String, errorMessage: String?, errorDetails: Any?) { this.errorCode = errorCode; completed.countDown() }
        override fun notImplemented() { errorCode = "NOT_IMPLEMENTED"; completed.countDown() }
        fun finish(): Reply { assertTrue("native reply completed", completed.await(5, TimeUnit.SECONDS)); return this }
        fun map(): Map<*, *> { finish(); assertNull(errorCode); return value as Map<*, *> }
    }
    private lateinit var prefs: AuditPreferences
    private lateinit var context: AuditContext
    private val old = SessionToken("A", "S", 2, 7)
    private val fresh = SessionToken("A", "S", 3, 8)

    @Before fun freshHarness() {
        prefs = AuditPreferences()
        context = AuditContext(prefs)
        NativeOwnershipCoordinator.resetForTesting(context)
        DutyForegroundService.resetForTesting(context, DutyForegroundService())
        DutyForegroundService.startTimeoutMs = 60000
        DutyForegroundService.syncStartupForTesting = true
    }
    @After fun reset() { NativeOwnershipCoordinator.resetForTesting() }
    private fun invoke(method: String, arguments: Map<String, Any?> = emptyMap()): Reply {
        val reply = Reply()
        NativeOwnershipCoordinator.onMethodCall(MethodCall(method, arguments), reply)
        return reply
    }
    private fun json(t: SessionToken, state: String = NativeOwnershipCoordinator.STATE_ACTIVE): String = JSONObject()
        .put("uid", t.uid).put("sessionId", t.sessionId).put("generation", t.generation)
        .put("lifecycleSeq", t.lifecycleSeq).put("startedAt", "2026-10-01T00:00:00Z")
        .put("state", state).toString()
    private fun install(t: SessionToken) {
        synchronized(NativeOwnershipCoordinator.ownershipLock) {
            prefs.edit().putString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, json(t))
                .putString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, json(t))
                .putLong(NativeOwnershipCoordinator.KEY_MONOTONIC_SEQUENCE, t.lifecycleSeq)
                .putString(NativeOwnershipCoordinator.KEY_OWNER_STATE, NativeOwnershipCoordinator.STATE_ACTIVE).commit()
        }
    }
    private fun acquire(operation: String = "logout-old", uid: String = "A") = invoke("beginCleanupAcquisition", mapOf("operationId" to operation, "expectedUid" to uid)).map()
    private fun resolve(lease: Map<*, *>) = invoke("resolveCleanupAcquisition", mapOf("token" to lease["token"], "operationId" to lease["operationId"])).finish().value as Map<*, *>
    private fun owner(): String? = prefs.getString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, null)
    private fun assertTuple(t: SessionToken, value: String?) {
        assertNotNull(value)
        val parsed = JSONObject(value!!)
        assertEquals(t.uid, parsed.getString("uid")); assertEquals(t.sessionId, parsed.getString("sessionId"))
        assertEquals(t.generation, parsed.getInt("generation")); assertEquals(t.lifecycleSeq, parsed.getLong("lifecycleSeq"))
    }
    private fun stop(t: SessionToken, lease: Map<*, *>, tokenOverride: Any? = lease["token"], operationOverride: Any? = lease["operationId"]): Reply = invoke("atomicStopService", mapOf(
        "expectedUid" to t.uid, "expectedSessionId" to t.sessionId, "expectedGeneration" to t.generation,
        "expectedLifecycleSeq" to t.lifecycleSeq, "cleanupToken" to tokenOverride, "cleanupOperationId" to operationOverride))
    private fun start(t: SessionToken): Reply = invoke("atomicStartService", mapOf(
        "uid" to t.uid, "sessionId" to t.sessionId, "dutyGeneration" to t.generation, "lifecycleSeq" to t.lifecycleSeq,
        "sessionPayloadJson" to json(t), "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 901L)))

    @Test fun A_exactCaptureAndUniqueImmutableLease() {
        install(old)
        val first = acquire(); val second = acquire("logout-second")
        assertTrue(first["captured"] == true); assertTuple(old, first["owner"] as String)
        assertNotEquals(first["token"], second["token"])
        assertEquals(first, resolve(first)); assertTuple(old, owner())
    }
    @Test fun B_generationReplacementCannotRebindOrBeStopped() { replacement(fresh) }
    @Test fun C_lifecycleOnlyReplacementCannotRebindOrBeStopped() { replacement(old.copy(lifecycleSeq = 8)) }
    @Test fun D_differentUidReplacementCannotRebindOrBeStopped() { replacement(fresh.copy(uid = "B")) }
    @Test fun historicalGenerationReplacementWithLowerLifecycleCannotRebind() { replacement(old.copy(generation = 3, lifecycleSeq = 1)) }
    private fun replacement(t: SessionToken) {
        install(old); val lease = acquire(); install(t)
        assertEquals(lease, resolve(lease)); assertTuple(old, resolve(lease)["owner"] as String)
        val stopped = stop(old, lease).map(); assertEquals(false, stopped["stopped"])
        assertTuple(t, owner())
        assertEquals("INVALID_CLEANUP_ACQUISITION", stop(t, lease).finish().errorCode)
        assertTuple(t, owner())
    }
    @Test fun E_noneLeaseStaysNoneAndHasNoStopAuthority() {
        val lease = acquire(); assertEquals(false, lease["captured"]); assertNull(lease["owner"])
        install(fresh); assertEquals(lease, resolve(lease))
        var destructiveEntries = 0
        NativeOwnershipCoordinator.testHook = { action, _ -> if (action == "before_atomic_stop") destructiveEntries++ }
        assertEquals("INVALID_CLEANUP_ACQUISITION", stop(fresh, lease).finish().errorCode)
        assertEquals(0, destructiveEntries); assertTuple(fresh, owner())
    }
    @Test fun F_wrongTokenAndWrongOperationAndWrongEpochFailBeforeStop() {
        install(old); val lease = acquire(); var entered = 0
        NativeOwnershipCoordinator.testHook = { action, _ -> if (action == "before_atomic_stop") entered++ }
        assertEquals("INVALID_CLEANUP_ACQUISITION", stop(old, lease, "unissued").finish().errorCode)
        assertEquals("INVALID_CLEANUP_ACQUISITION", stop(old, lease, operationOverride = "foreign-operation").finish().errorCode)
        assertEquals("INVALID_CLEANUP_ACQUISITION", stop(fresh, lease).finish().errorCode)
        assertEquals(0, entered); assertTuple(old, owner())
    }
    @Test fun F_staleReleaseCannotReleaseNewSameUidAcquisition() {
        install(old); val first = acquire(); install(fresh); val second = acquire("logout-new")
        assertEquals(false, invoke("releaseCleanupAcquisition", mapOf("token" to first["token"], "operationId" to "logout-new")).finish().value)
        assertEquals(true, invoke("releaseCleanupAcquisition", mapOf("token" to first["token"], "operationId" to first["operationId"])).finish().value)
        assertEquals(false, invoke("releaseCleanupAcquisition", mapOf("token" to first["token"], "operationId" to first["operationId"])).finish().value)
        assertEquals(second, resolve(second)); assertEquals("INVALID_CLEANUP_ACQUISITION", stop(fresh, first).finish().errorCode)
        assertTuple(fresh, owner())
    }
    @Test fun H_freshNativeContextCanCleanExactColdResidual() {
        install(old); val lease = acquire(); assertTuple(old, lease["owner"] as String)
        assertEquals(true, stop(old, lease).map()["stopped"])
        assertNull(owner()); assertNull(invoke("getDurableOwner").finish().value)
        assertEquals(false, invoke("isServiceRunning").finish().value)
    }
    @Test fun G_pendingActualStartCapturedThenStopCannotRunLate() {
        DutyForegroundService.holdPendingStartsForTesting = true
        assertEquals(NativeOwnershipCoordinator.STATE_PENDING_START, start(old).map()["state"])
        assertEquals(1, DutyForegroundService.pendingStartIntentsForTesting.size)
        val lease = acquire(); assertTuple(old, lease["owner"] as String)
        assertEquals(true, stop(old, lease).map()["stopped"])
        DutyForegroundService.executePendingStartsForTesting()
        assertNull(owner()); assertFalse(DutyForegroundService.isRunning)
        assertFalse(DutyForegroundService.hasBindingForToken(old))
    }
    @Test fun G_newPendingStartAfterAcquisitionSurvivesOldCleanupAndRuns() {
        install(old); val lease = acquire()
        DutyForegroundService.holdPendingStartsForTesting = true
        start(fresh).map(); assertTuple(fresh, owner())
        assertEquals(false, stop(old, lease).map()["stopped"])
        DutyForegroundService.executePendingStartsForTesting()
        assertTuple(fresh, owner()); assertEquals(fresh, DutyForegroundService.getActiveToken())
        assertTrue(DutyForegroundService.isHealthyRunning())
    }
    @Test fun G_acquisitionBlocksAtActualStartInstallationLockBoundary() {
        val installed = CountDownLatch(1); val allowStart = CountDownLatch(1)
        val captured = AtomicReference<Map<*, *>>()
        NativeOwnershipCoordinator.testHook = { action, _ -> if (action == "after_persistence_before_service_start") {
            installed.countDown(); assertTrue(allowStart.await(5, TimeUnit.SECONDS))
        } }
        DutyForegroundService.holdPendingStartsForTesting = true
        val starter = Thread { start(old).map() }; starter.start()
        assertTrue(installed.await(5, TimeUnit.SECONDS))
        val reader = Thread { captured.set(acquire()) }; reader.start()
        assertTrue("acquisition waits on ownership lock", reader.isAlive)
        assertNull(captured.get()); allowStart.countDown()
        starter.join(5000); reader.join(5000)
        assertFalse(starter.isAlive); assertFalse(reader.isAlive); assertTuple(old, captured.get()["owner"] as String)
        assertEquals(true, stop(old, captured.get()).map()["stopped"])
        DutyForegroundService.executePendingStartsForTesting(); assertNull(owner()); assertFalse(DutyForegroundService.isRunning)
    }
    @Test fun G_delayedOldEffectiveTeardownPreservesActualNewStart() {
        assertEquals(true, start(old).map()["active"])
        val lease = acquire(); val resume = AtomicReference<(Boolean, String?) -> Unit>()
        DutyForegroundService.teardownInterceptor = { _, proceed -> resume.set(proceed) }
        val reply = stop(old, lease); assertEquals(1L, reply.completed.count)
        DutyForegroundService.teardownInterceptor = null
        assertEquals(true, start(fresh).map()["active"])
        resume.get().invoke(true, null)
        assertEquals(true, reply.map()["stopped"]); assertTuple(fresh, owner())
        assertEquals(fresh, DutyForegroundService.getActiveToken()); assertTrue(DutyForegroundService.isHealthyRunning())
    }
}
