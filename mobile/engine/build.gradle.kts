plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

// The database side: one session type per driver (MySQL/MariaDB, PostgreSQL, SQLite, MongoDB, Redis), SSH tunnels,
// and the SQL helpers they share (statement splitting, quoting, the destructive-statement check). No UI.
android {
    namespace = "com.brainfactory.db.engine"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
        // The syntax suites in src/androidTest run every driver on a device against real servers (see their docs).
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    // The test APK targets the same SDK as the app, so it runs under the same rules (no exec of app files on 29+).
    testOptions {
        targetSdk = 35
    }
    packaging {
        resources.excludes += setOf("META-INF/versions/*/OSGI-INF/MANIFEST.MF", "META-INF/versions/*/module-info.class", "module-info.class", "META-INF/native-image/**", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }
}

// pgjdbc calls java.lang.management (absent on Android) whenever it connects, from one class: the jar is used without
// it, and src/main/java/org/postgresql/util has a copy of that class without java.lang.management.
val pgjdbc: Configuration by configurations.creating { isTransitive = false }
val pgjdbcAndroid = tasks.register<Jar>("pgjdbcAndroid") {
    from({ pgjdbc.map { zipTree(it) } }) {
        exclude("org/postgresql/util/PGPropertyMaxResultBufferParser.class")
        exclude("META-INF/*.SF", "META-INF/*.RSA", "META-INF/*.DSA")
    }
    archiveFileName.set("postgresql-android.jar")
    destinationDirectory.set(layout.buildDirectory.dir("pgjdbc"))
}

dependencies {
    implementation(libs.kotlinx.coroutines.android)
    api(libs.mariadb)
    pgjdbc(libs.postgresql)
    api(files(pgjdbcAndroid))
    api(libs.mongodb)
    implementation(libs.jsch)
    implementation(libs.bouncycastle)
    testImplementation(libs.junit)
    testImplementation(libs.json)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.junit)
}
