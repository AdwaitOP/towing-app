import 'dart:async';
import 'package:cloud_firestore/cloud_firestore.dart';
import '../models/driver_profile.dart';

/// Represents the authoritative state of a driver profile in Firestore.
sealed class ProfileState {
  const ProfileState();
}

/// Profile exists, satisfies canonical schema, and all required Stage 1 fields are filled.
class ProfileCompleted extends ProfileState {
  final DriverProfile profile;
  const ProfileCompleted(this.profile);
}

/// Profile document exists and conforms to schema, but required fields are incomplete.
class ProfileIncomplete extends ProfileState {
  final DriverProfile profile;
  const ProfileIncomplete(this.profile);
}

/// Profile document does not exist in Firestore (`!snapshot.exists`).
class ProfileNotFound extends ProfileState {
  const ProfileNotFound();
}

/// Profile document exists, but violates data types, unrecognized truckType, or corrupted.
class ProfileMalformed extends ProfileState {
  final String error;
  const ProfileMalformed(this.error);
}

/// Firestore stream or read error (e.g. permission denied, network failure).
class ProfileError extends ProfileState {
  final Object error;
  const ProfileError(this.error);
}

/// Service managing driver profile retrieval and creation in Firestore (`drivers/{uid}`).
class ProfileService {
  final FirebaseFirestore? firestore;

  ProfileService({this.firestore});

  FirebaseFirestore get _db => firestore ?? FirebaseFirestore.instance;

  CollectionReference<Map<String, dynamic>> get _driversCollection =>
      _db.collection('drivers');

  /// Streams the authoritative [ProfileState] for the given [uid].
  Stream<ProfileState> streamProfileState(String uid) {
    if (uid.isEmpty) return Stream.value(const ProfileNotFound());

    return _driversCollection.doc(uid).snapshots().transform(
      StreamTransformer<DocumentSnapshot<Map<String, dynamic>>, ProfileState>.fromHandlers(
        handleData: (snapshot, sink) {
          if (!snapshot.exists || snapshot.data() == null) {
            sink.add(const ProfileNotFound());
            return;
          }

          final data = snapshot.data()!;
          try {
            final profile = DriverProfile.fromMap(data, snapshot.id);
            if (profile.isCompleted) {
              sink.add(ProfileCompleted(profile));
            } else {
              sink.add(ProfileIncomplete(profile));
            }
          } catch (e) {
            sink.add(ProfileMalformed(e.toString()));
          }
        },
        handleError: (error, stackTrace, sink) {
          sink.add(ProfileError(error));
        },
      ),
    );
  }

  /// Streams the driver profile for the given [uid].
  /// Emits null if the document does not exist.
  Stream<DriverProfile?> streamProfile(String uid) {
    return streamProfileState(uid).map((state) {
      if (state is ProfileCompleted) return state.profile;
      if (state is ProfileIncomplete) return state.profile;
      if (state is ProfileMalformed) throw FormatException(state.error);
      if (state is ProfileError) throw state.error;
      return null;
    });
  }

  /// Fetches the driver profile document once.
  /// Returns null if the document does not exist.
  Future<DriverProfile?> getProfile(String uid) async {
    if (uid.isEmpty) return null;
    final doc = await _driversCollection.doc(uid).get();
    if (!doc.exists || doc.data() == null) {
      return null;
    }
    return DriverProfile.fromFirestore(doc);
  }

  /// Creates initial driver profile in `drivers/{uid}` adhering to strict Firestore rules.
  ///
  /// The document ID MUST match the authenticated user's UID.
  /// The write contains ONLY the 8 allowlisted fields:
  /// `uid`, `name`, `phone`, `truckType`, `vehicleNumber`, `isOnDuty`, `createdAt`, `updatedAt`.
  ///
  /// Resilient to double-tap and existing documents:
  /// If the document already exists, it re-reads authoritative state instead of overwriting.
  Future<DriverProfile> createProfile(DriverProfile profile) async {
    final docRef = _driversCollection.doc(profile.uid);

    // Check if document was already created in a previous attempt / race
    final existingDoc = await docRef.get();
    if (existingDoc.exists && existingDoc.data() != null) {
      return DriverProfile.fromFirestore(existingDoc);
    }

    final payload = profile.toInitialCreatePayload();

    // Perform the initial document create
    await docRef.set(payload);

    // Authoritative re-read post commit
    final freshSnap = await docRef.get();
    if (!freshSnap.exists || freshSnap.data() == null) {
      // In rare latency cases fallback to the input model with local time
      return profile.copyWith(
        createdAt: DateTime.now(),
        updatedAt: DateTime.now(),
      );
    }

    return DriverProfile.fromFirestore(freshSnap);
  }
}
