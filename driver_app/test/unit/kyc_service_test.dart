// ignore_for_file: subtype_of_sealed_class
import 'dart:async';
import 'dart:io';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:driver_app/core/models/kyc_error_category.dart';
import 'package:driver_app/core/services/kyc_service.dart';
import 'package:firebase_storage/firebase_storage.dart';
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
  final HttpsCallable callable;
  FakeFirebaseFunctions(this.callable);

  @override
  HttpsCallable httpsCallable(String name, {HttpsCallableOptions? options}) => callable;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeUploadTask implements UploadTask {
  final Future<TaskSnapshot> _future;
  FakeUploadTask(this._future);

  @override
  Future<S> then<S>(FutureOr<S> Function(TaskSnapshot) onValue, {Function? onError}) =>
      _future.then(onValue, onError: onError);

  @override
  Future<TaskSnapshot> timeout(Duration timeLimit, {FutureOr<TaskSnapshot> Function()? onTimeout}) =>
      _future.timeout(timeLimit, onTimeout: onTimeout);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeReference implements Reference {
  final String pathString;
  final Future<TaskSnapshot> Function(File, SettableMetadata?, String) onPut;
  FakeReference({this.pathString = '', required this.onPut});

  @override
  Reference child(String path) => FakeReference(
        pathString: pathString.isEmpty ? path : '$pathString/$path',
        onPut: onPut,
      );

  @override
  UploadTask putFile(File file, [SettableMetadata? metadata]) {
    return FakeUploadTask(onPut(file, metadata, pathString));
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeFirebaseStorage implements FirebaseStorage {
  final Reference rootRef;
  FakeFirebaseStorage(this.rootRef);

  @override
  Reference ref([String? path]) => rootRef;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('KycService Unit Tests', () {
    late Directory tempDir;

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync('kyc_service_test_');
    });

    tearDown(() {
      try {
        if (tempDir.existsSync()) {
          tempDir.deleteSync(recursive: true);
        }
      } catch (_) {}
    });

    File createTempFile(String name) {
      final file = File('${tempDir.path}/$name');
      file.writeAsStringSync('file content');
      return file;
    }

    group('uploadKycFile', () {
      test('throws KycAuthException if driverUid is empty or whitespace', () async {
        final service = KycService();
        final dummyFile = createTempFile('test.jpg');

        expect(
          () => service.uploadKycFile(driverUid: '', filename: 'id.jpg', file: dummyFile),
          throwsA(isA<KycAuthException>()),
        );

        expect(
          () => service.uploadKycFile(driverUid: '   ', filename: 'id.jpg', file: dummyFile),
          throwsA(isA<KycAuthException>()),
        );
      });

      test('throws KycUploadException if file does not exist', () async {
        final service = KycService();
        final nonExistentFile = File('${tempDir.path}/missing.jpg');

        expect(
          () => service.uploadKycFile(driverUid: 'driver_1', filename: 'id.jpg', file: nonExistentFile),
          throwsA(isA<KycUploadException>().having(
            (e) => e.message,
            'message',
            contains('Document file does not exist'),
          )),
        );
      });

      test('successfully uploads file when storage succeeds', () async {
        final dummyFile = createTempFile('id.jpg');
        String? capturedPath;
        SettableMetadata? capturedMetadata;

        late FakeReference fakeRef;
        fakeRef = FakeReference(
          onPut: (file, metadata, path) async {
            capturedMetadata = metadata;
            capturedPath = path;
            return FakeTaskSnapshot();
          },
        );

        final fakeStorage = FakeFirebaseStorage(fakeRef);
        final service = KycService(storage: fakeStorage);

        await service.uploadKycFile(
          driverUid: 'driver_123',
          filename: 'id.jpg',
          file: dummyFile,
        );

        expect(capturedMetadata?.contentType, equals('image/jpeg'));
        expect(capturedPath, equals('driver_verification/driver_123/id.jpg'));
      });

      test('maps permission-denied to KycUploadException with status explanation', () async {
        final dummyFile = createTempFile('id.jpg');
        final fakeRef = FakeReference(
          onPut: (file, metadata, path) async {
            throw FirebaseException(
              plugin: 'firebase_storage',
              code: 'permission-denied',
              message: 'Access denied',
            );
          },
        );

        final service = KycService(storage: FakeFirebaseStorage(fakeRef));

        expect(
          () => service.uploadKycFile(driverUid: 'driver_123', filename: 'id.jpg', file: dummyFile),
          throwsA(isA<KycUploadException>().having(
            (e) => e.message,
            'message',
            contains('Storage upload permission denied. Verify driver verification status.'),
          )),
        );
      });

      test('maps unauthorized to KycUploadException with status explanation', () async {
        final dummyFile = createTempFile('id.jpg');
        final fakeRef = FakeReference(
          onPut: (file, metadata, path) async {
            throw FirebaseException(
              plugin: 'firebase_storage',
              code: 'unauthorized',
              message: 'Unauthorized',
            );
          },
        );

        final service = KycService(storage: FakeFirebaseStorage(fakeRef));

        expect(
          () => service.uploadKycFile(driverUid: 'driver_123', filename: 'id.jpg', file: dummyFile),
          throwsA(isA<KycUploadException>().having(
            (e) => e.message,
            'message',
            contains('Storage upload permission denied. Verify driver verification status.'),
          )),
        );
      });
    });

    group('submitDriverVerification callable', () {
      test('successfully returns server response map', () async {
        final fakeCallable = FakeHttpsCallable((_) async {
          return FakeHttpsCallableResult<Map<String, dynamic>>({
            'success': true,
            'status': 'pending',
          });
        });

        final service = KycService(functions: FakeFirebaseFunctions(fakeCallable));
        final result = await service.submitDriverVerification();

        expect(result['success'], isTrue);
        expect(result['status'], equals('pending'));
      });

      test('maps unauthenticated FirebaseFunctionsException to KycAuthException', () async {
        final fakeCallable = FakeHttpsCallable((_) async {
          throw FirebaseFunctionsException(
            code: 'unauthenticated',
            message: 'Driver must be authenticated',
          );
        });

        final service = KycService(functions: FakeFirebaseFunctions(fakeCallable));
        expect(
          () => service.submitDriverVerification(),
          throwsA(isA<KycAuthException>().having(
            (e) => e.category,
            'category',
            equals(KycErrorCategory.sessionChanged),
          )),
        );
      });

      test('maps not-found FirebaseFunctionsException to KycNotFoundException', () async {
        final fakeCallable = FakeHttpsCallable((_) async {
          throw FirebaseFunctionsException(
            code: 'not-found',
            message: 'INTERNAL_SECRET_123 Driver profile not found',
          );
        });

        final service = KycService(functions: FakeFirebaseFunctions(fakeCallable));
        expect(
          () => service.submitDriverVerification(),
          throwsA(isA<KycNotFoundException>()
              .having((e) => e.category, 'category', equals(KycErrorCategory.genericKycError))
              .having((e) => e.message.contains('INTERNAL_SECRET_123'), 'does not leak raw backend message', isFalse)),
        );
      });

      test('maps failed-precondition FirebaseFunctionsException to KycPreconditionException', () async {
        final fakeCallable = FakeHttpsCallable((_) async {
          throw FirebaseFunctionsException(
            code: 'failed-precondition',
            message: 'INTERNAL_FIREBASE_SECRET_DIAGNOSTIC_123 Missing KYC document: selfie.jpg',
          );
        });

        final service = KycService(functions: FakeFirebaseFunctions(fakeCallable));
        expect(
          () => service.submitDriverVerification(),
          throwsA(isA<KycPreconditionException>()
              .having((e) => e.category, 'category', equals(KycErrorCategory.documentsMissing))
              .having((e) => e.message.contains('INTERNAL_FIREBASE_SECRET_DIAGNOSTIC_123'), 'does not leak raw backend message', isFalse)),
        );
      });

      test('maps internal FirebaseFunctionsException to KycServerException', () async {
        final fakeCallable = FakeHttpsCallable((_) async {
          throw FirebaseFunctionsException(
            code: 'internal',
            message: 'INTERNAL_STACK_TRACE_SECRET Internal server error',
          );
        });

        final service = KycService(functions: FakeFirebaseFunctions(fakeCallable));
        expect(
          () => service.submitDriverVerification(),
          throwsA(isA<KycServerException>()
              .having((e) => e.category, 'category', equals(KycErrorCategory.verificationSubmissionFailed))
              .having((e) => e.message.contains('INTERNAL_STACK_TRACE_SECRET'), 'does not leak raw backend message', isFalse)),
        );
      });

      test('maps non-Firebase exception to KycNetworkException', () async {
        final fakeCallable = FakeHttpsCallable((_) async {
          throw const SocketException('Connection refused');
        });

        final service = KycService(functions: FakeFirebaseFunctions(fakeCallable));
        expect(
          () => service.submitDriverVerification(),
          throwsA(isA<KycNetworkException>().having(
            (e) => e.category,
            'category',
            equals(KycErrorCategory.networkError),
          )),
        );
      });
    });
  });
}

class FakeTaskSnapshot implements TaskSnapshot {
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
