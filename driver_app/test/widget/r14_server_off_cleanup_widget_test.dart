import 'package:driver_app/core/models/driver_profile.dart';
import 'package:driver_app/core/models/truck_type.dart';
import 'package:driver_app/core/services/location_service.dart';
import 'package:driver_app/core/services/native_ownership_coordinator.dart';
import 'package:driver_app/features/hub/controllers/duty_controller.dart';
import 'package:driver_app/features/hub/models/duty_session.dart';
import 'package:driver_app/features/hub/models/duty_state.dart';
import 'package:driver_app/features/hub/screens/dispatch_hub_screen.dart';
import 'package:driver_app/l10n/app_localizations.dart';
import 'package:driver_app/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import '../unit/duty_controller_test.dart' as f;
import '../unit/r14_server_off_native_absence_test.dart' as r14;

class _WidgetServerOffLocationService extends r14.ServerOffLocationService {
  @override
  Stream<DriverPosition> getPositionStream() => const Stream.empty();

  @override
  Future<DriverPosition?> getCurrentPosition() async => null;
}

void main() {
  testWidgets(
    'R14 replacement cleanup remains visible after dismissal and OFF profile update',
    (tester) async {
      NativeOwnershipCoordinator.resetTestSimulation();
      const exact = DutySession(
        uid: 'uid-a',
        sessionId: 'session-a',
        generation: 2,
        lifecycleSeq: 7,
      );
      const replacement = DutySession(
        uid: 'uid-a',
        sessionId: 'session-a',
        generation: 2,
        lifecycleSeq: 8,
      );
      const cachedOn = DriverProfile(
        uid: 'uid-a',
        name: 'Driver A',
        phone: '+919876543210',
        truckType: TruckType.flatbed,
        vehicleNumber: 'MH 12 AB 1234',
        verificationStatus: 'approved',
        isOnDuty: true,
        activeDutySessionId: 'session-a',
        dutyGeneration: 2,
        lifecycleSeq: 7,
        workerReady: true,
      );
      final auth = f.TestAuthService(f.FakeUser(exact.uid));
      final location = _WidgetServerOffLocationService();
      final controller = DutyController(
        locationService: location,
        authService: auth,
      );
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      DutySession? nativeOwner = exact;
      var nativeRunning = true;
      final stops = <DutySession>[];
      messenger.setMockMethodCallHandler(NativeOwnershipCoordinator.channel, (
        call,
      ) async {
        switch (call.method) {
          case 'getDurableOwner':
            final owner = nativeOwner;
            if (owner == null) return null;
            return DurableDutyOwnerRecord(
              uid: owner.uid,
              sessionId: owner.sessionId,
              generation: owner.generation,
              lifecycleSeq: owner.lifecycleSeq!,
              startedAt: DateTime.utc(2026, 10, 1),
            ).encode();
          case 'isServiceRunning':
            return nativeRunning;
          case 'atomicStopService':
            final args = Map<String, dynamic>.from(call.arguments as Map);
            stops.add(
              DutySession(
                uid: args['expectedUid'] as String,
                sessionId: args['expectedSessionId'] as String,
                generation: args['expectedGeneration'] as int,
                lifecycleSeq: args['expectedLifecycleSeq'] as int,
              ),
            );
            // A new active epoch acquires native authority before the old STOP.
            if (stops.length == 1) nativeOwner = replacement;
            final mismatch = nativeOwner != stops.last;
            if (!mismatch) {
              nativeOwner = null;
              nativeRunning = false;
            }
            return {
              'success': true,
              'stopped': !mismatch,
              if (mismatch) 'reason': 'mismatch',
            };
          default:
            throw StateError('Unexpected native call ${call.method}');
        }
      });
      addTearDown(() {
        controller.dispose();
        location.dispose();
        auth.dispose();
        messenger.setMockMethodCallHandler(
          NativeOwnershipCoordinator.channel,
          null,
        );
        NativeOwnershipCoordinator.resetTestSimulation();
      });

      Widget hub(DriverProfile profile) => MaterialApp(
        theme: AppTheme.darkTheme,
        locale: const Locale('en'),
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        home: DispatchHubScreen(
          key: const ValueKey('r14_hub'),
          profile: profile,
          authService: auth,
          locationService: location,
          controller: controller,
          mapWidgetBuilder: (_, _) => const SizedBox(),
        ),
      );

      await tester.pumpWidget(hub(cachedOn));
      await tester.pumpAndSettle();
      final l10n = AppLocalizations.of(
        tester.element(find.byType(DispatchHubScreen)),
      )!;

      void expectCleanup() {
        expect(
          controller.authoritativeDutyState,
          AuthoritativeDutyState.offDuty,
        );
        expect(controller.trackingHealth, TrackingHealth.reconciliationFailed);
        expect(controller.pendingCleanupSession, exact);
        expect(controller.isCleanupRequired, isTrue);
        expect(controller.canToggleDuty, isFalse);
        expect(nativeOwner, replacement);
        expect(nativeRunning, isTrue);
        final status = find.byKey(const ValueKey('duty_status_card'));
        expect(
          find.descendant(
            of: status,
            matching: find.text(l10n.dutyAttentionRequired),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(of: status, matching: find.text('Cleanup required')),
          findsOneWidget,
        );
        expect(find.text(l10n.hubStatusOffDuty), findsNothing);
        expect(
          find.byKey(const ValueKey('retry_cleanup_button')),
          findsOneWidget,
        );
        final toggle = tester.widget<ElevatedButton>(
          find.byKey(const ValueKey('duty_toggle_button')),
        );
        expect(toggle.onPressed, isNull);
      }

      expectCleanup();
      expect(stops, [exact]);
      final errorCard = find.byKey(const ValueKey('hub_error_card'));
      await tester.tap(
        find.descendant(of: errorCard, matching: find.byIcon(Icons.close)),
      );
      await tester.pumpAndSettle();
      expect(errorCard, findsNothing);
      expectCleanup();

      // didUpdateWidget receives OFF and schedules reconciliation again.
      await tester.pumpWidget(hub(cachedOn.copyWith(isOnDuty: false)));
      await tester.pumpAndSettle();
      expectCleanup();
      expect(stops, [exact, exact]);

      final retry = find.byKey(const ValueKey('retry_cleanup_button'));
      await tester.ensureVisible(retry);
      await tester.tap(retry);
      await tester.pumpAndSettle();
      expectCleanup();
      expect(stops, [exact, exact, exact]);
      await tester.pumpWidget(const SizedBox());
    },
  );
}
