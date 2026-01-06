FROM jenkins/jenkins:lts

# Skip initial setup wizard
ENV JAVA_OPTS="-Djenkins.install.runSetupWizard=false"

# Install plugins
RUN jenkins-plugin-cli --plugins \
    generic-webhook-trigger \
    git \
    workflow-aggregator \
    configuration-as-code
