package com.towingapp.driver_app

import android.content.Context
import io.flutter.plugin.common.MethodCall
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class NativeCleanupAcquisitionTest {
    private lateinit var prefs: NativeOwnershipCoordinatorTest.InMemorySharedPreferences
    private lateinit var context: NativeOwnershipCoordinatorTest.FakeContext
    @Before fun setup() {
        prefs = NativeOwnershipCoordinatorTest.InMemorySharedPreferences()
        context = NativeOwnershipCoordinatorTest.FakeContext(prefs)
        val service = DutyForegroundService()
        DutyForegroundService.resetForTesting(context, service)
        service.onCreate()
        NativeOwnershipCoordinator.resetForTesting(context)
    }
    private fun call(method: String, args: Map<String, Any?> = emptyMap()): NativeOwnershipCoordinatorTest.MockMethodResult {
        val result = NativeOwnershipCoordinatorTest.MockMethodResult()
        NativeOwnershipCoordinator.onMethodCall(MethodCall(method, args), result)
        return result
    }
    private fun install(uid: String = "A", gen: Int = 2, seq: Long = 7): String {
        val raw = JSONObject().put("uid", uid).put("sessionId", "S")
            .put("generation", gen).put("lifecycleSeq", seq).put("state", "ACTIVE")
            .put("startedAt", "2026-10-01T00:00:00.000Z").toString()
        synchronized(NativeOwnershipCoordinator.ownershipLock) {
            prefs.edit().putString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, raw)
                .putString(NativeOwnershipCoordinator.KEY_WORKER_PAYLOAD, raw)
                .putLong(NativeOwnershipCoordinator.KEY_MONOTONIC_SEQUENCE, seq).commit()
        }
        return raw
    }
    private fun acquire(op: String = "old"): Map<*, *> =
        call("beginCleanupAcquisition", mapOf("operationId" to op, "expectedUid" to "A")).successResult as Map<*, *>
    private fun args(lease: Map<*, *>, op: String = lease["operationId"] as String) =
        mapOf("token" to lease["token"], "operationId" to op)
    private fun resolve(lease: Map<*, *>): Map<*, *> =
        call("resolveCleanupAcquisition", args(lease)).successResult as Map<*, *>
    private fun stop(lease: Map<*, *>, seq: Long = 7, gen: Int = 2, op: String = "old") =
        call("atomicStopService", mapOf("expectedUid" to "A", "expectedSessionId" to "S",
            "expectedGeneration" to gen, "expectedLifecycleSeq" to seq,
            "cleanupToken" to lease["token"], "cleanupOperationId" to op))

    @Test fun capturesOriginalExactEpoch() {
        val original = install()
        val lease = acquire()
        assertEquals(true, lease["captured"])
        assertEquals(original, lease["owner"])
        assertNotNull(lease["token"])
    }
    private fun replacement(uid: String, gen: Int, seq: Long) {
        val original = install()
        val lease = acquire()
        val newer = install(uid, gen, seq)
        assertEquals(original, resolve(lease)["owner"])
        assertNull(stop(lease).errorCode)
        assertEquals(newer, call("getDurableOwner").successResult)
    }
    @Test fun generationReplacementRemainsImmutable() = replacement("A", 3, 8)
    @Test fun lifecycleOnlyReplacementRemainsImmutable() = replacement("A", 2, 8)
    @Test fun differentUidReplacementSurvives() = replacement("B", 3, 8)
    @Test fun noneNeverAdoptsLaterOwner() {
        val lease = acquire()
        assertEquals(false, lease["captured"])
        val newer = install(seq = 8)
        assertNull(resolve(lease)["owner"])
        assertEquals("INVALID_CLEANUP_ACQUISITION", stop(lease, seq = 8).errorCode)
        assertEquals(newer, call("getDurableOwner").successResult)
    }
    @Test fun staleOperationCannotUseOrReleaseNewLease() {
        install()
        val old = acquire()
        install(seq = 8)
        val newer = acquire("new")
        assertEquals(false, call("releaseCleanupAcquisition", args(newer, "old")).successResult)
        assertEquals("INVALID_CLEANUP_ACQUISITION", stop(newer, seq = 8).errorCode)
        assertEquals(true, call("releaseCleanupAcquisition", args(old)).successResult)
        assertEquals(true, call("validateCleanupAcquisition", args(newer)).successResult)
        assertEquals(false, call("validateCleanupAcquisition", args(old)).successResult)
    }
    @Test fun capturedTokenCannotStopReplacementTuple() {
        install()
        val lease = acquire()
        val newer = install(seq = 8)
        assertEquals("INVALID_CLEANUP_ACQUISITION", stop(lease, seq = 8).errorCode)
        assertEquals(newer, call("getDurableOwner").successResult)
    }
    @Test fun acquisitionRejectsCorruptAndOtherUidOwners() {
        install("B")
        assertEquals("UID_CONFLICT", call("beginCleanupAcquisition",
            mapOf("operationId" to "old", "expectedUid" to "A")).errorCode)
        prefs.edit().putString(NativeOwnershipCoordinator.KEY_OWNER_RECORD, "broken").commit()
        assertEquals("CORRUPT_RECORD", call("beginCleanupAcquisition",
            mapOf("operationId" to "old", "expectedUid" to "A")).errorCode)
    }
    private fun start(seq: Long, gen: Int): Map<*, *> {
        DutyForegroundService.holdPendingStartsForTesting = true
        val raw = JSONObject().put("uid", "A").put("sessionId", "S")
            .put("generation", gen).put("lifecycleSeq", seq)
            .put("startedAt", "2026-10-01T00:00:00.000Z").toString()
        val result = call("atomicStartService", mapOf("uid" to "A", "sessionId" to "S",
            "dutyGeneration" to gen, "lifecycleSeq" to seq, "sessionPayloadJson" to raw,
            "foregroundTaskOptionsMap" to mapOf("callbackHandle" to 10001L)))
        assertNull(result.errorCode)
        return result.successResult as Map<*, *>
    }
    @Test fun admittedStartBeforeAcquisitionIsCapturedAtNativeBoundary() {
        assertEquals(true, start(7, 2)["success"])
        assertEquals(true, start(8, 3)["success"])
        val lease = acquire()
        assertEquals(8L, JSONObject(lease["owner"] as String).getLong("lifecycleSeq"))
        assertEquals(true, start(9, 4)["success"])
        assertEquals(8L, JSONObject(resolve(lease)["owner"] as String).getLong("lifecycleSeq"))
        assertNull(stop(lease, 8, 3).errorCode)
        assertEquals(9L, JSONObject(call("getDurableOwner").successResult as String).getLong("lifecycleSeq"))
    }
    @Test fun actualStartAfterAcquisitionCannotRebindLease() {
        assertEquals(true, start(7, 2)["success"])
        val lease = acquire()
        assertEquals(true, start(8, 2)["success"])
        assertEquals(7L, JSONObject(resolve(lease)["owner"] as String).getLong("lifecycleSeq"))
        assertNull(stop(lease).errorCode)
        assertEquals(8L, JSONObject(call("getDurableOwner").successResult as String).getLong("lifecycleSeq"))
    }

}
