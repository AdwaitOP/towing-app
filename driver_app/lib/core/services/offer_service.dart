import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter/foundation.dart';

import '../models/job_offer.dart';

/// Structured result of an acceptJob callable invocation.
class AcceptJobResult {
  final bool accepted;
  final bool idempotent;
  final String jobId;
  final String offerId;
  final String driverId;

  const AcceptJobResult({
    required this.accepted,
    this.idempotent = false,
    required this.jobId,
    required this.offerId,
    required this.driverId,
  });

  factory AcceptJobResult.fromMap(Map<String, dynamic> data) {
    return AcceptJobResult(
      accepted: data['accepted'] == true,
      idempotent: data['idempotent'] == true,
      jobId: (data['jobId'] ?? '').toString(),
      offerId: (data['offerId'] ?? '').toString(),
      driverId: (data['driverId'] ?? '').toString(),
    );
  }
}

/// Structured result of a declineJob callable invocation.
class DeclineJobResult {
  final bool declined;
  final bool idempotent;
  final String jobId;
  final String offerId;
  final String driverId;
  final int? candidateIndex;

  const DeclineJobResult({
    required this.declined,
    this.idempotent = false,
    required this.jobId,
    required this.offerId,
    required this.driverId,
    this.candidateIndex,
  });

  factory DeclineJobResult.fromMap(Map<String, dynamic> data) {
    return DeclineJobResult(
      declined: data['declined'] == true,
      idempotent: data['idempotent'] == true,
      jobId: (data['jobId'] ?? '').toString(),
      offerId: (data['offerId'] ?? '').toString(),
      driverId: (data['driverId'] ?? '').toString(),
      candidateIndex: data['candidateIndex'] as int?,
    );
  }
}

/// Structured result of a startJob callable invocation.
class StartJobResult {
  final bool started;
  final bool idempotent;
  final String jobId;
  final String offerId;
  final String driverId;
  final String? reason;

  const StartJobResult({
    required this.started,
    this.idempotent = false,
    required this.jobId,
    required this.offerId,
    required this.driverId,
    this.reason,
  });

  factory StartJobResult.fromMap(Map<String, dynamic> data) {
    return StartJobResult(
      started: data['started'] == true,
      idempotent: data['idempotent'] == true,
      jobId: (data['jobId'] ?? '').toString(),
      offerId: (data['offerId'] ?? '').toString(),
      driverId: (data['driverId'] ?? '').toString(),
      reason: data['reason']?.toString(),
    );
  }
}

/// Structured result of a completeJob callable invocation.
class CompleteJobResult {
  final bool completed;
  final bool idempotent;
  final String jobId;
  final String offerId;
  final String driverId;
  final String? reason;

  const CompleteJobResult({
    required this.completed,
    this.idempotent = false,
    required this.jobId,
    required this.offerId,
    required this.driverId,
    this.reason,
  });

  factory CompleteJobResult.fromMap(Map<String, dynamic> data) {
    return CompleteJobResult(
      completed: data['completed'] == true,
      idempotent: data['idempotent'] == true,
      jobId: (data['jobId'] ?? '').toString(),
      offerId: (data['offerId'] ?? '').toString(),
      driverId: (data['driverId'] ?? '').toString(),
      reason: data['reason']?.toString(),
    );
  }
}

/// Structured result of a cancelJob callable invocation.
class CancelJobResult {
  final bool cancelled;
  final bool idempotent;
  final String jobId;
  final String offerId;
  final String driverId;
  final int forfeitedPaise;
  final int refundPaise;
  final String? reason;

  const CancelJobResult({
    required this.cancelled,
    this.idempotent = false,
    required this.jobId,
    required this.offerId,
    required this.driverId,
    this.forfeitedPaise = 0,
    this.refundPaise = 0,
    this.reason,
  });

  double get forfeitedRupees => forfeitedPaise / 100.0;
  double get refundRupees => refundPaise / 100.0;
  bool get isCustomerCancellationInProgress => reason == 'customer_cancellation_in_progress';
  bool get isCustomerCancelled => isCustomerCancellationInProgress;

  factory CancelJobResult.fromMap(Map<String, dynamic> data) {
    return CancelJobResult(
      cancelled: data['cancelled'] == true,
      idempotent: data['idempotent'] == true,
      jobId: (data['jobId'] ?? '').toString(),
      offerId: (data['offerId'] ?? '').toString(),
      driverId: (data['driverId'] ?? '').toString(),
      forfeitedPaise: (data['forfeitedPaise'] as int?) ?? 0,
      refundPaise: (data['refundPaise'] as int?) ?? 0,
      reason: data['reason']?.toString(),
    );
  }
}

/// Structured result of an initiateWalletTopup callable invocation.
class InitiateTopupResult {
  final String topupId;
  final String orderId;
  final int amountPaise;
  final String currency;
  final String keyId;
  final bool idempotent;

  const InitiateTopupResult({
    required this.topupId,
    required this.orderId,
    required this.amountPaise,
    this.currency = 'INR',
    this.keyId = 'rzp_test_mode',
    this.idempotent = false,
  });

  double get amountRupees => amountPaise / 100.0;

  factory InitiateTopupResult.fromMap(Map<String, dynamic> data) {
    return InitiateTopupResult(
      topupId: (data['topupId'] ?? '').toString(),
      orderId: (data['orderId'] ?? '').toString(),
      amountPaise: (data['amountPaise'] as int?) ?? 0,
      currency: (data['currency'] ?? 'INR').toString(),
      keyId: (data['keyId'] ?? 'rzp_test_mode').toString(),
      idempotent: data['idempotent'] == true,
    );
  }
}

/// Structured result of a simulateWalletTopupPayment / reconcileTopup callable invocation.
class ReconcileTopupResult {
  final bool credited;
  final bool idempotent;
  final String topupId;
  final String orderId;
  final String paymentId;
  final int amountPaise;
  final int? balanceAfterPaise;
  final String? reason;

  const ReconcileTopupResult({
    required this.credited,
    this.idempotent = false,
    required this.topupId,
    required this.orderId,
    required this.paymentId,
    required this.amountPaise,
    this.balanceAfterPaise,
    this.reason,
  });

  double get amountRupees => amountPaise / 100.0;
  double? get balanceAfterRupees => balanceAfterPaise != null ? balanceAfterPaise! / 100.0 : null;
  bool get success => credited;

  factory ReconcileTopupResult.fromMap(Map<String, dynamic> data) {
    return ReconcileTopupResult(
      credited: data['credited'] == true,
      idempotent: data['idempotent'] == true,
      topupId: (data['topupId'] ?? '').toString(),
      orderId: (data['orderId'] ?? '').toString(),
      paymentId: (data['paymentId'] ?? '').toString(),
      amountPaise: (data['amountPaise'] as int?) ?? 0,
      balanceAfterPaise: data['balanceAfterPaise'] as int?,
      reason: data['reason']?.toString(),
    );
  }
}

/// Domain exception for offer actions (accept/decline).
class OfferActionException implements Exception {
  final String code;
  final String message;
  final String? originalCode;

  const OfferActionException({
    required this.code,
    required this.message,
    this.originalCode,
  });

  bool get isInsufficientBalance => code == 'INSUFFICIENT_WALLET_BALANCE';
  bool get isOfferExpired => code == 'OFFER_EXPIRED';
  bool get isJobAlreadyAssigned => code == 'JOB_ALREADY_ASSIGNED';
  bool get isDriverBanned => code == 'DRIVER_BANNED';

  @override
  String toString() => 'OfferActionException($code): $message';
}

/// Service managing observation and actions for driver job offers.
class OfferService {
  final FirebaseFirestore? _customFirestore;
  final FirebaseFunctions? _customFunctions;

  OfferService({
    FirebaseFirestore? firestore,
    FirebaseFunctions? functions,
  })  : _customFirestore = firestore,
        _customFunctions = functions;

  FirebaseFirestore get firestore => _customFirestore ?? FirebaseFirestore.instance;
  FirebaseFunctions get functions => _customFunctions ?? FirebaseFunctions.instanceFor(region: 'asia-south1');

  /// Streams the authoritative active offer for the driver.
  ///
  /// Listens to `job_offers/{activeOfferId}` when [activeOfferId] is provided.
  /// If [activeOfferId] is null or empty, emits `null`.
  /// Fails closed if the offer document does not exist, belongs to another driver,
  /// or fails schema validation.
  Stream<JobOffer?> streamActiveOffer({
    required String driverId,
    required String? activeOfferId,
  }) {
    if (activeOfferId == null || activeOfferId.trim().isEmpty) {
      return Stream.value(null);
    }

    final trimmedId = activeOfferId.trim();
    return firestore
        .collection('job_offers')
        .doc(trimmedId)
        .snapshots()
        .map((snapshot) {
      if (!snapshot.exists || snapshot.data() == null) {
        return null;
      }
      try {
        final data = snapshot.data()!;
        if (data['driverId'] != driverId) {
          debugPrint('OfferService: driverId mismatch for offer $trimmedId');
          return null;
        }
        return JobOffer.fromFirestore(snapshot);
      } catch (e) {
        debugPrint('OfferService: Failed to parse offer $trimmedId: $e');
        return null;
      }
    });
  }

  /// Streams the accepted offer projection for an active assigned job.
  Stream<JobOffer?> streamAcceptedJobOffer({
    required String driverId,
    required String jobId,
  }) {
    return firestore
        .collection('job_offers')
        .where('driverId', isEqualTo: driverId)
        .where('jobId', isEqualTo: jobId)
        .snapshots()
        .map((querySnapshot) {
      if (querySnapshot.docs.isEmpty) return null;
      // Find matching accepted/inProgress/completed offer
      for (final doc in querySnapshot.docs) {
        try {
          final offer = JobOffer.fromFirestore(doc);
          if (offer.status == JobOfferStatus.accepted ||
              offer.status == JobOfferStatus.inProgress ||
              offer.status == JobOfferStatus.completed) {
            return offer;
          }
        } catch (e) {
          debugPrint('OfferService: Error parsing accepted offer ${doc.id}: $e');
        }
      }
      // Fallback to first parsable doc
      try {
        return JobOffer.fromFirestore(querySnapshot.docs.first);
      } catch (_) {
        return null;
      }
    });
  }

  /// Calls `acceptJob` callable with `{ jobId, offerId, requestId }`.
  ///
  /// Re-sending the same [requestId] on network retry ensures idempotent backend handling.
  Future<AcceptJobResult> acceptOffer({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    try {
      final callable = functions.httpsCallable('acceptJob');
      final response = await callable.call<dynamic>({
        'jobId': jobId,
        'offerId': offerId,
        'requestId': requestId,
      });

      final data = Map<String, dynamic>.from(response.data as Map);
      return AcceptJobResult.fromMap(data);
    } on FirebaseFunctionsException catch (e) {
      final domainCode = (e.details is Map && (e.details as Map)['code'] != null)
          ? (e.details as Map)['code'].toString()
          : e.message ?? e.code;
      throw OfferActionException(
        code: domainCode,
        message: e.message ?? 'Accept job failed',
        originalCode: e.code,
      );
    } catch (e) {
      if (e is OfferActionException) rethrow;
      throw OfferActionException(
        code: 'NETWORK_ERROR',
        message: e.toString(),
      );
    }
  }

  /// Calls `declineJob` callable with `{ jobId, offerId, requestId }`.
  Future<DeclineJobResult> declineOffer({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    try {
      final callable = functions.httpsCallable('declineJob');
      final response = await callable.call<dynamic>({
        'jobId': jobId,
        'offerId': offerId,
        'requestId': requestId,
      });

      final data = Map<String, dynamic>.from(response.data as Map);
      return DeclineJobResult.fromMap(data);
    } on FirebaseFunctionsException catch (e) {
      final domainCode = (e.details is Map && (e.details as Map)['code'] != null)
          ? (e.details as Map)['code'].toString()
          : e.message ?? e.code;
      throw OfferActionException(
        code: domainCode,
        message: e.message ?? 'Decline job failed',
        originalCode: e.code,
      );
    } catch (e) {
      if (e is OfferActionException) rethrow;
      throw OfferActionException(
        code: 'NETWORK_ERROR',
        message: e.toString(),
      );
    }
  }

  /// Calls `startJob` callable with `{ jobId, offerId, requestId }`.
  Future<StartJobResult> startJob({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    try {
      final callable = functions.httpsCallable('startJob');
      final response = await callable.call<dynamic>({
        'jobId': jobId,
        'offerId': offerId,
        'requestId': requestId,
      });

      final data = Map<String, dynamic>.from(response.data as Map);
      return StartJobResult.fromMap(data);
    } on FirebaseFunctionsException catch (e) {
      final domainCode = (e.details is Map && (e.details as Map)['code'] != null)
          ? (e.details as Map)['code'].toString()
          : e.message ?? e.code;
      throw OfferActionException(
        code: domainCode,
        message: e.message ?? 'Start job failed',
        originalCode: e.code,
      );
    } catch (e) {
      if (e is OfferActionException) rethrow;
      throw OfferActionException(
        code: 'NETWORK_ERROR',
        message: e.toString(),
      );
    }
  }

  /// Calls `completeJob` callable with `{ jobId, offerId, requestId }`.
  Future<CompleteJobResult> completeJob({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    try {
      final callable = functions.httpsCallable('completeJob');
      final response = await callable.call<dynamic>({
        'jobId': jobId,
        'offerId': offerId,
        'requestId': requestId,
      });

      final data = Map<String, dynamic>.from(response.data as Map);
      return CompleteJobResult.fromMap(data);
    } on FirebaseFunctionsException catch (e) {
      final domainCode = (e.details is Map && (e.details as Map)['code'] != null)
          ? (e.details as Map)['code'].toString()
          : e.message ?? e.code;
      throw OfferActionException(
        code: domainCode,
        message: e.message ?? 'Complete job failed',
        originalCode: e.code,
      );
    } catch (e) {
      if (e is OfferActionException) rethrow;
      throw OfferActionException(
        code: 'NETWORK_ERROR',
        message: e.toString(),
      );
    }
  }

  /// Calls `cancelJob` callable with exact keys `{ jobId, offerId, requestId }`.
  Future<CancelJobResult> cancelJob({
    required String jobId,
    required String offerId,
    required String requestId,
  }) async {
    try {
      final callable = functions.httpsCallable('cancelJob');
      final response = await callable.call<dynamic>({
        'jobId': jobId,
        'offerId': offerId,
        'requestId': requestId,
      });

      final data = Map<String, dynamic>.from(response.data as Map);
      return CancelJobResult.fromMap(data);
    } on FirebaseFunctionsException catch (e) {
      final domainCode = (e.details is Map && (e.details as Map)['code'] != null)
          ? (e.details as Map)['code'].toString()
          : e.message ?? e.code;
      throw OfferActionException(
        code: domainCode,
        message: e.message ?? 'Cancel job failed',
        originalCode: e.code,
      );
    } catch (e) {
      if (e is OfferActionException) rethrow;
      throw OfferActionException(
        code: 'NETWORK_ERROR',
        message: e.toString(),
      );
    }
  }

  /// Calls `initiateWalletTopup` callable with `{ amountPaise, requestId }`.
  Future<InitiateTopupResult> initiateWalletTopup({
    required int amountPaise,
    required String requestId,
  }) async {
    try {
      final callable = functions.httpsCallable('initiateWalletTopup');
      final response = await callable.call<dynamic>({
        'amountPaise': amountPaise,
        'requestId': requestId,
      });

      final data = Map<String, dynamic>.from(response.data as Map);
      return InitiateTopupResult.fromMap(data);
    } on FirebaseFunctionsException catch (e) {
      final domainCode = (e.details is Map && (e.details as Map)['code'] != null)
          ? (e.details as Map)['code'].toString()
          : e.message ?? e.code;
      throw OfferActionException(
        code: domainCode,
        message: e.message ?? 'Wallet top-up initiation failed',
        originalCode: e.code,
      );
    } catch (e) {
      if (e is OfferActionException) rethrow;
      throw OfferActionException(
        code: 'NETWORK_ERROR',
        message: e.toString(),
      );
    }
  }
}
