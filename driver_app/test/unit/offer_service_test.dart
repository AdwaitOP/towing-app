// ignore_for_file: subtype_of_sealed_class
import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:driver_app/core/models/job_offer.dart';
import 'package:driver_app/core/services/offer_service.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeHttpsCallableResult<T> implements HttpsCallableResult<T> {
  @override
  final T data;
  FakeHttpsCallableResult(this.data);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeHttpsCallable implements HttpsCallable {
  final Future<HttpsCallableResult<dynamic>> Function(dynamic) onCall;
  FakeHttpsCallable(this.onCall);

  @override
  Future<HttpsCallableResult<T>> call<T>([dynamic parameters]) async {
    final result = await onCall(parameters);
    return result as HttpsCallableResult<T>;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeFirebaseFunctions implements FirebaseFunctions {
  final Map<String, HttpsCallable> callables;
  FakeFirebaseFunctions(this.callables);

  @override
  HttpsCallable httpsCallable(String name, {HttpsCallableOptions? options}) {
    if (!callables.containsKey(name)) {
      throw UnimplementedError('Callable $name not configured in FakeFirebaseFunctions');
    }
    return callables[name]!;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeDocumentSnapshot implements DocumentSnapshot<Map<String, dynamic>> {
  @override
  final String id;
  final Map<String, dynamic>? _data;
  final bool _exists;

  FakeDocumentSnapshot(this.id, this._data, [this._exists = true]);

  @override
  bool get exists => _exists;

  @override
  Map<String, dynamic>? data() => _data;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeDocRef implements DocumentReference<Map<String, dynamic>> {
  final Stream<DocumentSnapshot<Map<String, dynamic>>> _stream;
  FakeDocRef(this._stream);

  @override
  Stream<DocumentSnapshot<Map<String, dynamic>>> snapshots({
    bool includeMetadataChanges = false,
    ListenSource source = ListenSource.defaultSource,
  }) => _stream;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeCollectionRef implements CollectionReference<Map<String, dynamic>> {
  final DocumentReference<Map<String, dynamic>> Function(String) onDoc;
  FakeCollectionRef(this.onDoc);

  @override
  DocumentReference<Map<String, dynamic>> doc([String? path]) => onDoc(path ?? '');

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeFirebaseFirestore implements FirebaseFirestore {
  final CollectionReference<Map<String, dynamic>> Function(String) onCollection;
  FakeFirebaseFirestore(this.onCollection);

  @override
  CollectionReference<Map<String, dynamic>> collection(String collectionPath) => onCollection(collectionPath);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  group('OfferService Unit Tests', () {
    final now = DateTime(2026, 10, 6, 12, 0, 0);
    final expiresAt = now.add(const Duration(seconds: 45));

    Map<String, dynamic> createOfferDocData({
      String driverId = 'driver_1',
      String status = 'offered',
    }) {
      return {
        'jobId': 'job_101',
        'driverId': driverId,
        'dispatchGeneration': 1,
        'candidateIndex': 0,
        'status': status,
        'pickupCoords': {'lat': 18.5204, 'lng': 73.8567},
        'destCoords': {'lat': 18.5500, 'lng': 73.8800},
        'requestedTruckType': 'flatbed',
        'estimatedFarePaise': 200000,
        'driverCommissionPaise': 30000,
        'offeredAt': Timestamp.fromDate(now),
        'expiresAt': Timestamp.fromDate(expiresAt),
      };
    }

    test('streamActiveOffer emits null when activeOfferId is null or empty', () async {
      final service = OfferService(
        firestore: FakeFirebaseFirestore((_) => throw UnimplementedError()),
      );

      final result1 = await service.streamActiveOffer(driverId: 'driver_1', activeOfferId: null).first;
      expect(result1, isNull);

      final result2 = await service.streamActiveOffer(driverId: 'driver_1', activeOfferId: '   ').first;
      expect(result2, isNull);
    });

    test('streamActiveOffer parses and emits valid offer matching driver', () async {
      final docController = StreamController<DocumentSnapshot<Map<String, dynamic>>>();
      final fakeFirestore = FakeFirebaseFirestore((col) {
        return FakeCollectionRef((docId) {
          expect(col, equals('job_offers'));
          expect(docId, equals('offer_555'));
          return FakeDocRef(docController.stream);
        });
      });

      final service = OfferService(firestore: fakeFirestore);
      final stream = service.streamActiveOffer(driverId: 'driver_1', activeOfferId: 'offer_555');

      final emitted = <JobOffer?>[];
      final sub = stream.listen(emitted.add);

      docController.add(FakeDocumentSnapshot('offer_555', createOfferDocData(driverId: 'driver_1')));
      await pumpEventQueue();

      expect(emitted.length, equals(1));
      expect(emitted.first, isNotNull);
      expect(emitted.first!.id, equals('offer_555'));
      expect(emitted.first!.jobId, equals('job_101'));
      expect(emitted.first!.status, equals(JobOfferStatus.offered));

      await sub.cancel();
      await docController.close();
    });

    test('streamActiveOffer emits null when driverId mismatches (security check)', () async {
      final docController = StreamController<DocumentSnapshot<Map<String, dynamic>>>();
      final fakeFirestore = FakeFirebaseFirestore((_) => FakeCollectionRef((_) => FakeDocRef(docController.stream)));

      final service = OfferService(firestore: fakeFirestore);
      final stream = service.streamActiveOffer(driverId: 'driver_1', activeOfferId: 'offer_555');

      final emitted = <JobOffer?>[];
      final sub = stream.listen(emitted.add);

      // Offer belongs to driver_DIFFERENT
      docController.add(FakeDocumentSnapshot('offer_555', createOfferDocData(driverId: 'driver_DIFFERENT')));
      await pumpEventQueue();

      expect(emitted.length, equals(1));
      expect(emitted.first, isNull);

      await sub.cancel();
      await docController.close();
    });

    test('streamActiveOffer fails closed (emits null) when document is missing or corrupted', () async {
      final docController = StreamController<DocumentSnapshot<Map<String, dynamic>>>();
      final fakeFirestore = FakeFirebaseFirestore((_) => FakeCollectionRef((_) => FakeDocRef(docController.stream)));

      final service = OfferService(firestore: fakeFirestore);
      final stream = service.streamActiveOffer(driverId: 'driver_1', activeOfferId: 'offer_555');

      final emitted = <JobOffer?>[];
      final sub = stream.listen(emitted.add);

      // 1. Doc does not exist
      docController.add(FakeDocumentSnapshot('offer_555', null, false));
      await pumpEventQueue();
      expect(emitted.last, isNull);

      // 2. Corrupt document (missing required fields)
      docController.add(FakeDocumentSnapshot('offer_555', {'status': 'offered'}));
      await pumpEventQueue();
      expect(emitted.last, isNull);

      await sub.cancel();
      await docController.close();
    });

    group('acceptOffer callable tests', () {
      test('calls acceptJob with correct payload and returns AcceptJobResult', () async {
        dynamic capturedParams;
        final fakeCallable = FakeHttpsCallable((params) async {
          capturedParams = params;
          return FakeHttpsCallableResult<Map<String, dynamic>>({
            'accepted': true,
            'jobId': 'job_101',
            'offerId': 'offer_555',
            'driverId': 'driver_1',
            'idempotent': false,
          });
        });

        final functions = FakeFirebaseFunctions({'acceptJob': fakeCallable});
        final service = OfferService(functions: functions);

        final result = await service.acceptOffer(
          jobId: 'job_101',
          offerId: 'offer_555',
          requestId: 'req_abc_1',
        );

        expect(capturedParams, equals({
          'jobId': 'job_101',
          'offerId': 'offer_555',
          'requestId': 'req_abc_1',
        }));
        expect(result.accepted, isTrue);
        expect(result.idempotent, isFalse);
        expect(result.jobId, equals('job_101'));
      });

      test('returns idempotent: true when backend signals idempotent retry replay', () async {
        final fakeCallable = FakeHttpsCallable((params) async {
          return FakeHttpsCallableResult<Map<String, dynamic>>({
            'accepted': true,
            'jobId': 'job_101',
            'offerId': 'offer_555',
            'driverId': 'driver_1',
            'idempotent': true,
          });
        });

        final service = OfferService(functions: FakeFirebaseFunctions({'acceptJob': fakeCallable}));

        final result = await service.acceptOffer(
          jobId: 'job_101',
          offerId: 'offer_555',
          requestId: 'req_abc_1',
        );

        expect(result.accepted, isTrue);
        expect(result.idempotent, isTrue);
      });

      test('maps INSUFFICIENT_WALLET_BALANCE to OfferActionException with isInsufficientBalance', () async {
        final fakeCallable = FakeHttpsCallable((_) async {
          throw FirebaseFunctionsException(
            message: 'Insufficient balance to accept offer',
            code: 'failed-precondition',
            details: {'code': 'INSUFFICIENT_WALLET_BALANCE'},
          );
        });

        final service = OfferService(functions: FakeFirebaseFunctions({'acceptJob': fakeCallable}));

        expect(
          () => service.acceptOffer(jobId: 'job_1', offerId: 'off_1', requestId: 'req_1'),
          throwsA(predicate((e) => e is OfferActionException && e.isInsufficientBalance)),
        );
      });

      test('maps OFFER_EXPIRED error code correctly', () async {
        final fakeCallable = FakeHttpsCallable((_) async {
          throw FirebaseFunctionsException(
            message: 'Offer has expired',
            code: 'failed-precondition',
            details: {'code': 'OFFER_EXPIRED'},
          );
        });

        final service = OfferService(functions: FakeFirebaseFunctions({'acceptJob': fakeCallable}));

        expect(
          () => service.acceptOffer(jobId: 'job_1', offerId: 'off_1', requestId: 'req_1'),
          throwsA(predicate((e) => e is OfferActionException && e.isOfferExpired)),
        );
      });

      test('maps JOB_ALREADY_ASSIGNED error code correctly', () async {
        final fakeCallable = FakeHttpsCallable((_) async {
          throw FirebaseFunctionsException(
            message: 'Job already assigned to another driver',
            code: 'failed-precondition',
            details: {'code': 'JOB_ALREADY_ASSIGNED'},
          );
        });

        final service = OfferService(functions: FakeFirebaseFunctions({'acceptJob': fakeCallable}));

        expect(
          () => service.acceptOffer(jobId: 'job_1', offerId: 'off_1', requestId: 'req_1'),
          throwsA(predicate((e) => e is OfferActionException && e.isJobAlreadyAssigned)),
        );
      });

      test('maps DRIVER_BANNED error code correctly', () async {
        final fakeCallable = FakeHttpsCallable((_) async {
          throw FirebaseFunctionsException(
            message: 'Driver is temporarily suspended',
            code: 'permission-denied',
            details: {'code': 'DRIVER_BANNED'},
          );
        });

        final service = OfferService(functions: FakeFirebaseFunctions({'acceptJob': fakeCallable}));

        expect(
          () => service.acceptOffer(jobId: 'job_1', offerId: 'off_1', requestId: 'req_1'),
          throwsA(predicate((e) => e is OfferActionException && e.isDriverBanned)),
        );
      });
    });

    group('declineOffer callable tests', () {
      test('calls declineJob with correct payload and returns DeclineJobResult', () async {
        dynamic capturedParams;
        final fakeCallable = FakeHttpsCallable((params) async {
          capturedParams = params;
          return FakeHttpsCallableResult<Map<String, dynamic>>({
            'declined': true,
            'jobId': 'job_101',
            'offerId': 'offer_555',
            'driverId': 'driver_1',
            'candidateIndex': 0,
            'idempotent': false,
          });
        });

        final service = OfferService(functions: FakeFirebaseFunctions({'declineJob': fakeCallable}));

        final result = await service.declineOffer(
          jobId: 'job_101',
          offerId: 'offer_555',
          requestId: 'req_dec_1',
        );

        expect(capturedParams, equals({
          'jobId': 'job_101',
          'offerId': 'offer_555',
          'requestId': 'req_dec_1',
        }));
        expect(result.declined, isTrue);
        expect(result.idempotent, isFalse);
      });
    });

    group('startJob callable tests', () {
      test('calls startJob with correct payload and returns StartJobResult', () async {
        dynamic capturedParams;
        final fakeCallable = FakeHttpsCallable((params) async {
          capturedParams = params;
          return FakeHttpsCallableResult<Map<String, dynamic>>({
            'started': true,
            'jobId': 'job_101',
            'offerId': 'offer_555',
            'driverId': 'driver_1',
            'idempotent': false,
          });
        });

        final service = OfferService(functions: FakeFirebaseFunctions({'startJob': fakeCallable}));

        final result = await service.startJob(
          jobId: 'job_101',
          offerId: 'offer_555',
          requestId: 'req_start_1',
        );

        expect(capturedParams, equals({
          'jobId': 'job_101',
          'offerId': 'offer_555',
          'requestId': 'req_start_1',
        }));
        expect(result.started, isTrue);
        expect(result.idempotent, isFalse);
      });

      test('returns idempotent: true when backend returns duplicate receipt', () async {
        final fakeCallable = FakeHttpsCallable((_) async {
          return FakeHttpsCallableResult<Map<String, dynamic>>({
            'started': true,
            'jobId': 'job_101',
            'offerId': 'offer_555',
            'driverId': 'driver_1',
            'idempotent': true,
          });
        });

        final service = OfferService(functions: FakeFirebaseFunctions({'startJob': fakeCallable}));

        final result = await service.startJob(
          jobId: 'job_101',
          offerId: 'offer_555',
          requestId: 'req_start_1',
        );

        expect(result.started, isTrue);
        expect(result.idempotent, isTrue);
      });
    });

    group('completeJob callable tests', () {
      test('calls completeJob with correct payload and returns CompleteJobResult', () async {
        dynamic capturedParams;
        final fakeCallable = FakeHttpsCallable((params) async {
          capturedParams = params;
          return FakeHttpsCallableResult<Map<String, dynamic>>({
            'completed': true,
            'jobId': 'job_101',
            'offerId': 'offer_555',
            'driverId': 'driver_1',
            'idempotent': false,
          });
        });

        final service = OfferService(functions: FakeFirebaseFunctions({'completeJob': fakeCallable}));

        final result = await service.completeJob(
          jobId: 'job_101',
          offerId: 'offer_555',
          requestId: 'req_comp_1',
        );

        expect(capturedParams, equals({
          'jobId': 'job_101',
          'offerId': 'offer_555',
          'requestId': 'req_comp_1',
        }));
        expect(result.completed, isTrue);
        expect(result.idempotent, isFalse);
      });
    });

    group('cancelJob callable tests', () {
      test('calls cancelJob with exact keys and returns CancelJobResult with penalty breakdown', () async {
        dynamic capturedParams;
        final fakeCallable = FakeHttpsCallable((params) async {
          capturedParams = params;
          return FakeHttpsCallableResult<Map<String, dynamic>>({
            'cancelled': true,
            'jobId': 'job_101',
            'offerId': 'offer_555',
            'driverId': 'driver_1',
            'forfeitedPaise': 2000,
            'refundPaise': 8000,
            'idempotent': false,
          });
        });

        final service = OfferService(functions: FakeFirebaseFunctions({'cancelJob': fakeCallable}));

        final result = await service.cancelJob(
          jobId: 'job_101',
          offerId: 'offer_555',
          requestId: 'req_cancel_1',
        );

        expect(capturedParams, equals({
          'jobId': 'job_101',
          'offerId': 'offer_555',
          'requestId': 'req_cancel_1',
        }));
        expect(result.cancelled, isTrue);
        expect(result.forfeitedPaise, equals(2000));
        expect(result.forfeitedRupees, equals(20.0));
        expect(result.refundPaise, equals(8000));
        expect(result.refundRupees, equals(80.0));
      });

      test('handles customer cancellation overlap non-penalizing response', () async {
        final fakeCallable = FakeHttpsCallable((_) async {
          return FakeHttpsCallableResult<Map<String, dynamic>>({
            'cancelled': false,
            'reason': 'customer_cancellation_in_progress',
            'jobId': 'job_101',
            'offerId': 'offer_555',
            'driverId': 'driver_1',
            'forfeitedPaise': 0,
            'refundPaise': 0,
          });
        });

        final service = OfferService(functions: FakeFirebaseFunctions({'cancelJob': fakeCallable}));

        final result = await service.cancelJob(
          jobId: 'job_101',
          offerId: 'offer_555',
          requestId: 'req_cancel_overlap',
        );

        expect(result.cancelled, isFalse);
        expect(result.isCustomerCancellationInProgress, isTrue);
        expect(result.forfeitedPaise, equals(0));
      });
    });

    group('wallet topup callable tests', () {
      test('initiateWalletTopup calls backend and returns InitiateTopupResult', () async {
        dynamic capturedParams;
        final fakeCallable = FakeHttpsCallable((params) async {
          capturedParams = params;
          return FakeHttpsCallableResult<Map<String, dynamic>>({
            'topupId': 'topup_req_top_1',
            'orderId': 'order_test_123',
            'amountPaise': 50000,
            'currency': 'INR',
            'keyId': 'rzp_test_mode',
            'idempotent': false,
          });
        });

        final service = OfferService(functions: FakeFirebaseFunctions({'initiateWalletTopup': fakeCallable}));

        final result = await service.initiateWalletTopup(
          amountPaise: 50000,
          requestId: 'req_top_1',
        );

        expect(capturedParams, equals({
          'amountPaise': 50000,
          'requestId': 'req_top_1',
        }));
        expect(result.topupId, equals('topup_req_top_1'));
        expect(result.orderId, equals('order_test_123'));
        expect(result.amountPaise, equals(50000));
        expect(result.amountRupees, equals(500.0));
      });
    });
  });
}
