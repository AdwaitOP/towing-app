// ignore_for_file: subtype_of_sealed_class
import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:driver_app/core/services/profile_service.dart';
import 'package:flutter_test/flutter_test.dart';

class FakeDocumentSnapshot implements DocumentSnapshot<Map<String, dynamic>> {
  final String _id;
  final Map<String, dynamic>? _data;
  final bool _exists;

  FakeDocumentSnapshot(this._id, this._data, [this._exists = true]);

  @override
  String get id => _id;

  @override
  Map<String, dynamic>? data() => _data;

  @override
  bool get exists => _exists;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeDocRef implements DocumentReference<Map<String, dynamic>> {
  final Stream<DocumentSnapshot<Map<String, dynamic>>> _snapshotsStream;
  FakeDocRef(this._snapshotsStream);

  @override
  Stream<DocumentSnapshot<Map<String, dynamic>>> snapshots({
    bool includeMetadataChanges = false,
    ListenSource source = ListenSource.defaultSource,
  }) => _snapshotsStream;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeCollectionRef implements CollectionReference<Map<String, dynamic>> {
  final FakeDocRef docRef;
  FakeCollectionRef(this.docRef);

  @override
  DocumentReference<Map<String, dynamic>> doc([String? path]) => docRef;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeFirestore implements FirebaseFirestore {
  final FakeCollectionRef colRef;
  FakeFirestore(this.colRef);

  @override
  CollectionReference<Map<String, dynamic>> collection(String collectionPath) => colRef;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  group('ProfileService Stream Error Propagation & State Sequences', () {
    test('(A) emits ProfileError when stream error occurs before any snapshot', () async {
      final controller = StreamController<DocumentSnapshot<Map<String, dynamic>>>();
      final service = ProfileService(firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(controller.stream))));

      final emitted = <ProfileState>[];
      final sub = service.streamProfileState('driver_uid_1').listen(emitted.add);

      final testError = FirebaseException(
        plugin: 'cloud_firestore',
        code: 'unavailable',
        message: 'Backend connection failed',
      );
      controller.addError(testError);
      await pumpEventQueue();

      expect(emitted.length, equals(1));
      expect(emitted.first, isA<ProfileError>());
      expect((emitted.first as ProfileError).error, equals(testError));

      await sub.cancel();
      await controller.close();
    });

    test('(B) emits ProfileCompleted then ProfileError when stream errors after completed snapshot', () async {
      final controller = StreamController<DocumentSnapshot<Map<String, dynamic>>>();
      final service = ProfileService(firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(controller.stream))));

      final emitted = <ProfileState>[];
      final sub = service.streamProfileState('driver_uid_1').listen(emitted.add);

      final completedData = {
        'uid': 'driver_uid_1',
        'name': 'Suresh Raina',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 12 AB 1234',
        'isOnDuty': false,
      };

      controller.add(FakeDocumentSnapshot('driver_uid_1', completedData, true));
      await pumpEventQueue();

      expect(emitted.length, equals(1));
      expect(emitted[0], isA<ProfileCompleted>());
      expect((emitted[0] as ProfileCompleted).profile.name, equals('Suresh Raina'));

      final testError = FirebaseException(
        plugin: 'cloud_firestore',
        code: 'permission-denied',
        message: 'Security rule evaluated to false',
      );
      controller.addError(testError);
      await pumpEventQueue();

      expect(emitted.length, equals(2));
      expect(emitted[1], isA<ProfileError>());
      expect((emitted[1] as ProfileError).error, equals(testError));

      await sub.cancel();
      await controller.close();
    });

    test('(C) emits ProfileIncomplete then ProfileError when stream errors after incomplete snapshot', () async {
      final controller = StreamController<DocumentSnapshot<Map<String, dynamic>>>();
      final service = ProfileService(firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(controller.stream))));

      final emitted = <ProfileState>[];
      final sub = service.streamProfileState('driver_uid_1').listen(emitted.add);

      final incompleteData = {
        'uid': 'driver_uid_1',
        'name': '',
        'phone': '+919876543210',
        'truckType': 'flatbed',
        'vehicleNumber': '',
        'isOnDuty': false,
      };

      controller.add(FakeDocumentSnapshot('driver_uid_1', incompleteData, true));
      await pumpEventQueue();

      expect(emitted.length, equals(1));
      expect(emitted[0], isA<ProfileIncomplete>());

      final testError = FirebaseException(
        plugin: 'cloud_firestore',
        code: 'deadline-exceeded',
        message: 'Timeout waiting for upstream',
      );
      controller.addError(testError);
      await pumpEventQueue();

      expect(emitted.length, equals(2));
      expect(emitted[1], isA<ProfileError>());
      expect((emitted[1] as ProfileError).error, equals(testError));

      await sub.cancel();
      await controller.close();
    });

    test('(D) emits ProfileNotFound then ProfileError when stream errors after not-found snapshot', () async {
      final controller = StreamController<DocumentSnapshot<Map<String, dynamic>>>();
      final service = ProfileService(firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(controller.stream))));

      final emitted = <ProfileState>[];
      final sub = service.streamProfileState('driver_uid_1').listen(emitted.add);

      controller.add(FakeDocumentSnapshot('driver_uid_1', null, false));
      await pumpEventQueue();

      expect(emitted.length, equals(1));
      expect(emitted[0], isA<ProfileNotFound>());

      final testError = Exception('SocketException: OS Error: Connection reset by peer');
      controller.addError(testError);
      await pumpEventQueue();

      expect(emitted.length, equals(2));
      expect(emitted[1], isA<ProfileError>());
      expect((emitted[1] as ProfileError).error, equals(testError));

      await sub.cancel();
      await controller.close();
    });

    test('emits ProfileMalformed on corrupt schema or bad types, distinctly separated from ProfileError', () async {
      final controller = StreamController<DocumentSnapshot<Map<String, dynamic>>>();
      final service = ProfileService(firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(controller.stream))));

      final emitted = <ProfileState>[];
      final sub = service.streamProfileState('driver_uid_1').listen(emitted.add);

      final malformedData = {
        'uid': 'driver_uid_1',
        'name': 99999, // integer instead of string
        'phone': '+919876543210',
        'truckType': 'flatbed',
        'vehicleNumber': 'MH 12 AB 1234',
      };

      controller.add(FakeDocumentSnapshot('driver_uid_1', malformedData, true));
      await pumpEventQueue();

      expect(emitted.length, equals(1));
      expect(emitted[0], isA<ProfileMalformed>());
      expect(emitted[0], isNot(isA<ProfileError>()));
      expect((emitted[0] as ProfileMalformed).error, contains('Driver profile name must be a string'));

      await sub.cancel();
      await controller.close();
    });

    test('emits ProfileMalformed when persisted uid is null (fails closed, never ProfileCompleted or ProfileIncomplete)', () async {
      final controller = StreamController<DocumentSnapshot<Map<String, dynamic>>>();
      final service = ProfileService(firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(controller.stream))));

      final emitted = <ProfileState>[];
      final sub = service.streamProfileState('driver_uid_1').listen(emitted.add);

      final nullUidData = {
        'uid': null,
        'name': 'Suresh Raina',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 12 AB 1234',
      };

      controller.add(FakeDocumentSnapshot('driver_uid_1', nullUidData, true));
      await pumpEventQueue();

      expect(emitted.length, equals(1));
      expect(emitted[0], isA<ProfileMalformed>());
      expect(emitted[0], isNot(isA<ProfileCompleted>()));
      expect(emitted[0], isNot(isA<ProfileIncomplete>()));
      expect(emitted[0], isNot(isA<ProfileError>()));

      await sub.cancel();
      await controller.close();
    });

    test('emits ProfileMalformed when persisted uid is missing from document', () async {
      final controller = StreamController<DocumentSnapshot<Map<String, dynamic>>>();
      final service = ProfileService(firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(controller.stream))));

      final emitted = <ProfileState>[];
      final sub = service.streamProfileState('driver_uid_1').listen(emitted.add);

      final missingUidData = {
        'name': 'Suresh Raina',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 12 AB 1234',
      };

      controller.add(FakeDocumentSnapshot('driver_uid_1', missingUidData, true));
      await pumpEventQueue();

      expect(emitted.length, equals(1));
      expect(emitted[0], isA<ProfileMalformed>());

      await sub.cancel();
      await controller.close();
    });

    test('emits ProfileMalformed when persisted uid does not match document ID', () async {
      final controller = StreamController<DocumentSnapshot<Map<String, dynamic>>>();
      final service = ProfileService(firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(controller.stream))));

      final emitted = <ProfileState>[];
      final sub = service.streamProfileState('driver_uid_1').listen(emitted.add);

      final mismatchUidData = {
        'uid': 'different_driver_uid',
        'name': 'Suresh Raina',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 12 AB 1234',
      };

      controller.add(FakeDocumentSnapshot('driver_uid_1', mismatchUidData, true));
      await pumpEventQueue();

      expect(emitted.length, equals(1));
      expect(emitted[0], isA<ProfileMalformed>());
      expect((emitted[0] as ProfileMalformed).error, contains('Driver profile uid mismatch'));

      await sub.cancel();
      await controller.close();
    });

    test('emits ProfileCompleted for valid document with legal server-owned fields', () async {
      final controller = StreamController<DocumentSnapshot<Map<String, dynamic>>>();
      final service = ProfileService(firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(controller.stream))));

      final emitted = <ProfileState>[];
      final sub = service.streamProfileState('driver_uid_1').listen(emitted.add);

      final serverOwnedDocData = {
        'uid': 'driver_uid_1',
        'name': 'Suresh Raina',
        'phone': '+919876543210',
        'truckType': 'hydraulic',
        'vehicleNumber': 'MH 12 AB 1234',
        'isOnDuty': false,
        'walletBalance': 5000,
        'canFlatbed': true,
        'activeJobId': 'job_12345',
        'verificationStatus': 'approved',
      };

      controller.add(FakeDocumentSnapshot('driver_uid_1', serverOwnedDocData, true));
      await pumpEventQueue();

      expect(emitted.length, equals(1));
      expect(emitted[0], isA<ProfileCompleted>());
      expect((emitted[0] as ProfileCompleted).profile.name, equals('Suresh Raina'));

      await sub.cancel();
      await controller.close();
    });

    test('streamProfile transforms ProfileError state back into stream error for downstream consumers', () async {
      final controller = StreamController<DocumentSnapshot<Map<String, dynamic>>>();
      final service = ProfileService(firestore: FakeFirestore(FakeCollectionRef(FakeDocRef(controller.stream))));

      final stream = service.streamProfile('driver_uid_1');
      final testError = FirebaseException(plugin: 'cloud_firestore', code: 'unavailable');
      controller.addError(testError);

      expect(stream, emitsError(equals(testError)));
      await controller.close();
    });

    test('empty uid immediately emits ProfileNotFound without querying firestore', () async {
      final service = ProfileService();
      final state = await service.streamProfileState('').first;
      expect(state, isA<ProfileNotFound>());
    });
  });
}
