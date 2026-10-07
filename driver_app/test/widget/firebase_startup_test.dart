import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:driver_app/main.dart';

void main() {
  group('Normal App Firebase Startup Contract & Error UI Tests', () {
    testWidgets('FirebaseInitializationErrorApp renders error details without eager Firebase SDK access', (tester) async {
      final stateError = StateError('Missing required production Firebase configuration: FIREBASE_API_KEY');

      await tester.pumpWidget(
        FirebaseInitializationErrorApp(error: stateError),
      );

      // Verify fail-closed presentation elements
      expect(find.byIcon(Icons.cloud_off), findsOneWidget);
      expect(find.text('Firebase Initialization Error'), findsOneWidget);
      expect(find.textContaining('Missing required production Firebase configuration'), findsOneWidget);
      expect(find.text('Retry Startup'), findsOneWidget);
      expect(find.byType(ElevatedButton), findsOneWidget);

      // Verify no red screen / FlutterError occurred
      expect(tester.takeException(), isNull);
    });

    testWidgets('FirebaseInitializationErrorApp renders with generic exception cleanly', (tester) async {
      final genericException = Exception('Failed to connect to Firebase backend service');

      await tester.pumpWidget(
        FirebaseInitializationErrorApp(error: genericException),
      );

      expect(find.byIcon(Icons.cloud_off), findsOneWidget);
      expect(find.text('Firebase Initialization Error'), findsOneWidget);
      expect(find.textContaining('Failed to connect to Firebase backend service'), findsOneWidget);
      expect(find.text('Retry Startup'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
