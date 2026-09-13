import 'dart:async';
import 'package:driver_app/core/config/app_config.dart';
import 'package:driver_app/core/config/firebase_options.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Firebase & AppConfig Configuration Integrity', () {
    test('production mode does not default functionsBaseUrl to localhost and fails closed when absent', () {
      if (!AppConfig.useFirebaseEmulator) {
        // Without explicit --dart-define=FUNCTIONS_BASE_URL, reading functionsBaseUrl must fail closed
        expect(
          () => AppConfig.functionsBaseUrl,
          throwsStateError,
          reason: 'Production functionsBaseUrl must not default to localhost or arbitrary endpoints',
        );
      }
    });

    test('production mode fails closed if required Firebase credentials are missing', () async {
      if (!AppConfig.useFirebaseEmulator) {
        // In default test environment without --dart-define, initialize() must fail closed with StateError
        expect(
          () => FirebaseBootstrap.initialize(),
          throwsStateError,
          reason: 'FirebaseBootstrap must fail closed rather than injecting fabricated project/api keys',
        );
      }
    });

    test('emulator ports are consistent across Auth, Firestore, and Functions', () {
      expect(AppConfig.authEmulatorPort, equals(9099));
      expect(AppConfig.firestoreEmulatorPort, equals(8080));
      expect(AppConfig.functionsEmulatorPort, equals(5001));
      expect(AppConfig.emulatorProjectId, equals('towing-app'));
    });

    group('Production Fail-Closed Matrix (A through G)', () {
      const validApiKey = 'AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6';
      const validAppId = '1:123456789012:android:abcdef1234567890';
      const validProjectId = 'towing-app-production-live';
      const validSenderId = '123456789012';
      const validBucket = 'towing-app-production-live.appspot.com';

      test('A: all production Firebase values present constructs FirebaseOptions successfully', () {
        final options = FirebaseBootstrap.buildProductionOptions(
          apiKey: validApiKey,
          appId: validAppId,
          projectId: validProjectId,
          messagingSenderId: validSenderId,
          storageBucket: validBucket,
        );

        expect(options.apiKey, equals(validApiKey));
        expect(options.appId, equals(validAppId));
        expect(options.projectId, equals(validProjectId));
        expect(options.messagingSenderId, equals(validSenderId));
        expect(options.storageBucket, equals(validBucket));
      });

      test('B: messagingSenderId missing fails closed', () {
        // Without supplying messagingSenderId (defaults to empty compile-time define)
        expect(
          () => FirebaseBootstrap.buildProductionOptions(
            apiKey: validApiKey,
            appId: validAppId,
            projectId: validProjectId,
          ),
          throwsStateError,
        );
      });

      test('C: messagingSenderId empty fails closed', () {
        expect(
          () => FirebaseBootstrap.buildProductionOptions(
            apiKey: validApiKey,
            appId: validAppId,
            projectId: validProjectId,
            messagingSenderId: '',
          ),
          throwsStateError,
        );
      });

      test('D: messagingSenderId whitespace fails closed', () {
        expect(
          () => FirebaseBootstrap.buildProductionOptions(
            apiKey: validApiKey,
            appId: validAppId,
            projectId: validProjectId,
            messagingSenderId: '   ',
          ),
          throwsStateError,
        );
      });

      test('E: messagingSenderId "0" fails closed (fabricated sentinel rejected)', () {
        expect(
          () => FirebaseBootstrap.buildProductionOptions(
            apiKey: validApiKey,
            appId: validAppId,
            projectId: validProjectId,
            messagingSenderId: '0',
          ),
          throwsStateError,
        );

        expect(
          () => FirebaseBootstrap.buildProductionOptions(
            apiKey: validApiKey,
            appId: validAppId,
            projectId: validProjectId,
            messagingSenderId: '  0  ',
          ),
          throwsStateError,
        );
      });

      test('F: partial production configuration fails closed', () {
        // Missing apiKey
        expect(
          () => FirebaseBootstrap.buildProductionOptions(
            apiKey: '',
            appId: validAppId,
            projectId: validProjectId,
            messagingSenderId: validSenderId,
          ),
          throwsStateError,
        );

        // Missing appId
        expect(
          () => FirebaseBootstrap.buildProductionOptions(
            apiKey: validApiKey,
            appId: '',
            projectId: validProjectId,
            messagingSenderId: validSenderId,
          ),
          throwsStateError,
        );

        // Missing projectId
        expect(
          () => FirebaseBootstrap.buildProductionOptions(
            apiKey: validApiKey,
            appId: validAppId,
            projectId: '',
            messagingSenderId: validSenderId,
          ),
          throwsStateError,
        );

        // Whitespace apiKey
        expect(
          () => FirebaseBootstrap.buildProductionOptions(
            apiKey: '   ',
            appId: validAppId,
            projectId: validProjectId,
            messagingSenderId: validSenderId,
          ),
          throwsStateError,
        );
      });

      test('G: exact supplied values propagate unchanged to FirebaseOptions', () {
        const exactKey = 'EXACT_PROD_API_KEY_777';
        const exactApp = '1:999888777:android:999888777';
        const exactProj = 'exact-production-project-id';
        const exactSender = '999888777666';
        const exactBucket = 'exact-storage-bucket.appspot.com';

        final options = FirebaseBootstrap.buildProductionOptions(
          apiKey: exactKey,
          appId: exactApp,
          projectId: exactProj,
          messagingSenderId: exactSender,
          storageBucket: exactBucket,
        );

        expect(options.apiKey, equals(exactKey));
        expect(options.appId, equals(exactApp));
        expect(options.projectId, equals(exactProj));
        expect(options.messagingSenderId, equals(exactSender));
        expect(options.storageBucket, equals(exactBucket));
      });
    });

    group('Functions Emulator Routing Precedence Matrix (A through G)', () {
      const defaultEmulatorUrl = 'http://10.0.2.2:5001/towing-app/asia-south1';
      const prodUrl = 'https://asia-south1-towing-app-prod.cloudfunctions.net';

      test('A: emulator=true, FUNCTIONS_BASE_URL absent resolves to emulator URL', () {
        final url = AppConfig.resolveFunctionsBaseUrl(
          useEmulator: true,
          productionUrl: '',
        );
        expect(url, equals(defaultEmulatorUrl));
      });

      test('B: emulator=true, FUNCTIONS_BASE_URL set to production URL resolves strictly to emulator URL', () {
        final url = AppConfig.resolveFunctionsBaseUrl(
          useEmulator: true,
          productionUrl: prodUrl,
        );
        expect(url, equals(defaultEmulatorUrl));
        expect(url, isNot(contains(prodUrl)));
      });

      test('C: emulator=true, FUNCTIONS_BASE_URL set to another localhost URL resolves to canonical configured emulator URL', () {
        final url = AppConfig.resolveFunctionsBaseUrl(
          useEmulator: true,
          productionUrl: 'http://localhost:9999/different-path',
        );
        expect(url, equals(defaultEmulatorUrl));
      });

      test('D: emulator=true, custom EMULATOR_HOST uses that host', () {
        final url = AppConfig.resolveFunctionsBaseUrl(
          useEmulator: true,
          productionUrl: prodUrl,
          host: '192.168.1.50',
          port: 5001,
          projectId: 'custom-proj',
        );
        expect(url, equals('http://192.168.1.50:5001/custom-proj/asia-south1'));
      });

      test('E: emulator=false, valid FUNCTIONS_BASE_URL resolves to exact production URL', () {
        final url = AppConfig.resolveFunctionsBaseUrl(
          useEmulator: false,
          productionUrl: prodUrl,
        );
        expect(url, equals(prodUrl));
      });

      test('F: emulator=false, FUNCTIONS_BASE_URL missing fails closed', () {
        expect(
          () => AppConfig.resolveFunctionsBaseUrl(
            useEmulator: false,
            productionUrl: '',
          ),
          throwsStateError,
        );
      });

      test('G: emulator=false, FUNCTIONS_BASE_URL whitespace fails closed', () {
        expect(
          () => AppConfig.resolveFunctionsBaseUrl(
            useEmulator: false,
            productionUrl: '   ',
          ),
          throwsStateError,
        );
      });
    });

    group('Auth, Firestore & Functions Environment Consistency (Astra Proof)', () {
      test('emulator configuration is coherent across all three services', () {
        const host = '10.0.2.2';
        expect(AppConfig.emulatorHost, equals(host));
        expect(AppConfig.authEmulatorPort, equals(9099));
        expect(AppConfig.firestoreEmulatorPort, equals(8080));
        expect(AppConfig.functionsEmulatorPort, equals(5001));

        final functionsUrl = AppConfig.resolveFunctionsBaseUrl(
          useEmulator: true,
          productionUrl: 'https://leak-attempt.example.com',
        );
        final functionsUri = Uri.parse(functionsUrl);

        expect(functionsUri.scheme, equals('http'));
        expect(functionsUri.host, equals(host));
        expect(functionsUri.port, equals(AppConfig.functionsEmulatorPort));
        expect(functionsUri.pathSegments.first, equals(AppConfig.emulatorProjectId));
        expect(functionsUri.pathSegments[1], equals('asia-south1'));
      });

      test('production configuration fails closed without cross-environment contamination', () {
        expect(
          () => AppConfig.resolveFunctionsBaseUrl(useEmulator: false, productionUrl: ''),
          throwsStateError,
        );

        expect(
          () => FirebaseBootstrap.buildProductionOptions(
            apiKey: '',
            appId: '',
            projectId: '',
            messagingSenderId: '',
            storageBucket: '',
          ),
          throwsStateError,
        );
      });
    });

    group('Stage 2 Firebase Bootstrap & Storage Bucket Integrity (Finding #5)', () {
      test('emulator mode has deterministic emulator storageBucket', () {
        expect(AppConfig.emulatorStorageBucket, equals('towing-app.appspot.com'));
        expect(AppConfig.storageEmulatorPort, equals(9199));
      });

      test('production mode requires storageBucket and fails closed when absent or whitespace', () {
        expect(
          () => FirebaseBootstrap.buildProductionOptions(
            apiKey: 'apiKey',
            appId: 'appId',
            projectId: 'proj',
            messagingSenderId: '12345',
            storageBucket: '',
          ),
          throwsStateError,
        );

        expect(
          () => FirebaseBootstrap.buildProductionOptions(
            apiKey: 'apiKey',
            appId: 'appId',
            projectId: 'proj',
            messagingSenderId: '12345',
            storageBucket: '   ',
          ),
          throwsStateError,
        );
      });

      test('production mode accepts valid storageBucket and does not leak emulator endpoints', () {
        final options = FirebaseBootstrap.buildProductionOptions(
          apiKey: 'apiKey',
          appId: 'appId',
          projectId: 'proj',
          messagingSenderId: '12345',
          storageBucket: 'my-prod-bucket.appspot.com',
        );
        expect(options.storageBucket, equals('my-prod-bucket.appspot.com'));
      });
    });

    group('Storage Emulator Setup Awaited & Fail-Closed Integrity (Medium 2)', () {
      setUp(() {
        FirebaseBootstrap.authEmulatorConnector = (host, port) async {};
        FirebaseBootstrap.firestoreEmulatorConnector = (host, port) {};
        FirebaseBootstrap.storageEmulatorConnector = (host, port) async {};
        FirebaseBootstrap.functionsEmulatorConnector = (host, port) {};
      });

      tearDown(() {
        FirebaseBootstrap.authEmulatorConnector = null;
        FirebaseBootstrap.firestoreEmulatorConnector = null;
        FirebaseBootstrap.storageEmulatorConnector = null;
        FirebaseBootstrap.functionsEmulatorConnector = null;
      });

      test('Storage emulator setup held pending keeps connectToEmulators pending until released', () async {
        final completer = Completer<void>();
        bool storageSetupCompleted = false;
        bool connectCompleted = false;

        FirebaseBootstrap.storageEmulatorConnector = (host, port) async {
          await completer.future;
          storageSetupCompleted = true;
        };

        final future = FirebaseBootstrap.connectToEmulators().then((_) {
          connectCompleted = true;
        });

        await Future<void>.delayed(Duration.zero);
        expect(storageSetupCompleted, isFalse);
        expect(connectCompleted, isFalse);

        completer.complete();
        await future;

        expect(storageSetupCompleted, isTrue);
        expect(connectCompleted, isTrue);
      });

      test('Storage emulator setup failure fails connectToEmulators immediately without unhandled async error', () async {
        FirebaseBootstrap.storageEmulatorConnector = (host, port) async {
          throw Exception('Storage emulator offline on port $port');
        };

        expect(
          () => FirebaseBootstrap.connectToEmulators(),
          throwsA(isA<Exception>().having(
            (e) => e.toString(),
            'message',
            contains('Storage emulator offline on port 9199'),
          )),
        );
      });

      test('Functions emulator configuration executes strictly AFTER Storage setup succeeds', () async {
        final executionOrder = <String>[];

        FirebaseBootstrap.storageEmulatorConnector = (host, port) async {
          await Future<void>.delayed(const Duration(milliseconds: 10));
          executionOrder.add('storage');
        };
        FirebaseBootstrap.functionsEmulatorConnector = (host, port) {
          executionOrder.add('functions');
        };

        await FirebaseBootstrap.connectToEmulators();

        expect(executionOrder, equals(['storage', 'functions']));
      });
    });
  });
}