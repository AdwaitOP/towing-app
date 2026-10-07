import 'package:driver_app/features/hub/widgets/location_disclosure_dialog.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'test_helper.dart';

void main() {
  group('LocationDisclosureDialog Widget Tests', () {
    testWidgets('renders disclosure title, body, and action buttons', (tester) async {
      await tester.pumpWidget(
        createTestWidget(
          child: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () => LocationDisclosureDialog.show(context),
              child: const Text('Open Disclosure'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Open the dialog
      await tester.tap(find.text('Open Disclosure'));
      await tester.pumpAndSettle();

      // Verify content
      expect(find.byType(LocationDisclosureDialog), findsOneWidget);
      expect(find.text('Location Access & Dispatch'), findsOneWidget);
      expect(
        find.textContaining('Towing Driver collects location data to find nearby towing jobs'),
        findsOneWidget,
      );
      expect(find.text('Continue'), findsOneWidget);
      expect(find.text('Not Now'), findsOneWidget);
    });

    testWidgets('tapping Not Now returns false', (tester) async {
      bool? result;

      await tester.pumpWidget(
        createTestWidget(
          child: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () async {
                result = await LocationDisclosureDialog.show(context);
              },
              child: const Text('Open Disclosure'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Open Disclosure'));
      await tester.pumpAndSettle();

      // Tap Not Now
      await tester.tap(find.text('Not Now'));
      await tester.pumpAndSettle();

      expect(result, isFalse);
      expect(find.byType(LocationDisclosureDialog), findsNothing);
    });

    testWidgets('tapping Continue returns true', (tester) async {
      bool? result;

      await tester.pumpWidget(
        createTestWidget(
          child: Builder(
            builder: (context) => ElevatedButton(
              onPressed: () async {
                result = await LocationDisclosureDialog.show(context);
              },
              child: const Text('Open Disclosure'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Open Disclosure'));
      await tester.pumpAndSettle();

      // Tap Continue
      await tester.tap(find.text('Continue'));
      await tester.pumpAndSettle();

      expect(result, isTrue);
      expect(find.byType(LocationDisclosureDialog), findsNothing);
    });
  });
}
